require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: ["http://localhost:5173", "https://snaap-gallery.netlify.app"],
  credentials: true
}));

// Increase body parser limit
app.use(express.urlencoded({ extended: true, limit: '2gb' }));
app.use(express.json({ limit: '2gb' }));

// Disable server timeout for big uploads
app.use((req, res, next) => {
  req.setTimeout(0); // disable timeout for long uploads
  next();
});

// Base upload directory
const baseUploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(baseUploadDir)) fs.mkdirSync(baseUploadDir);
app.use('/uploads', express.static(baseUploadDir));

// Chunk temp folder
const tmpChunkDir = path.join(__dirname, 'tmp_chunks');
if (!fs.existsSync(tmpChunkDir)) fs.mkdirSync(tmpChunkDir);

// MongoDB setup
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.mojyanw.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
});
let mediaCollection;
async function connectDB() {
  await client.connect();
  const db = client.db('snapVaultDB');
  mediaCollection = db.collection('media');
  console.log('✅ Connected to MongoDB');
}
connectDB().catch(console.error);

// Multer setup for standard uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let folder = req.body.folder || 'others';
    folder = folder.replace(/[^a-zA-Z0-9-_]/g, '') || 'others';
    const uploadPath = path.join(baseUploadDir, folder);
    fs.mkdir(uploadPath, { recursive: true }, err => cb(err, uploadPath));
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueName + path.extname(file.originalname));
  },
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 * 1024 } }); // 20GB

// Routes
app.get('/', (req, res) => res.send('snap-vault-server is running'));

app.post('/media', upload.single('media'), async (req, res) => {
  try {
    const { title, type, isPrivate, folder, uploaderName } = req.body;
    if (!req.file) return res.status(400).send('No file uploaded');
    const folderName = (folder || 'others').replace(/[^a-zA-Z0-9-_]/g, '') || 'others';
    const mediaDoc = {
      title: title || req.file.originalname,
      type,
      url: `/uploads/${folderName}/${req.file.filename}`,
      isPrivate: isPrivate === 'true',
      folder: folderName,
      createdAt: new Date(),
      uploaderName: uploaderName || 'Unknown',
      downloadCount: 0,
    };
    const result = await mediaCollection.insertOne(mediaDoc);
    res.json({ success: true, mediaId: result.insertedId, media: mediaDoc });
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to upload media');
  }
});

app.post('/media/multi', upload.array('media'), async (req, res) => {
  try {
    const { title, isPrivate, folder, uploaderName, category } = req.body;
    const folderName = (folder || 'others').replace(/[^a-zA-Z0-9-_]/g, '') || 'others';
    const categoryName = category?.trim() || 'Uncategorized';
    if (!req.files || req.files.length === 0) return res.status(400).send('No files uploaded');
    const mediaDocs = req.files.map(file => ({
      title: title || file.originalname,
      type: file.mimetype.startsWith('video') ? 'video' : 'image',
      url: `/uploads/${folderName}/${file.filename}`,
      isPrivate: isPrivate === 'true',
      category: categoryName,
      folder: folderName,
      createdAt: new Date(),
      uploaderName: uploaderName || 'Unknown',
      downloadCount: 0,
    }));
    const result = await mediaCollection.insertMany(mediaDocs);
    res.json({ success: true, count: result.insertedCount, media: mediaDocs });
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to upload files');
  }
});

// Chunk upload setup
const chunkStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, tmpChunkDir),
  filename: (req, file, cb) => cb(null, `${req.body.uploadId}-${req.body.chunkIndex}`),
});
const chunkUpload = multer({ 
  storage: chunkStorage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB chunk size
});
app.post('/upload/chunk', chunkUpload.single('chunk'), (req, res) => {
  console.log(`✅ Received chunk ${req.body.chunkIndex} for ${req.body.uploadId}`);
  if (!req.file) return res.status(400).send('No chunk uploaded');
  res.json({ success: true });
});

const uploadNone = multer();
app.post('/upload/complete', uploadNone.none(), async (req, res) => {
  const { uploadId, fileName, totalChunks, title, type, isPrivate, folder, category } = req.body;
  if (!uploadId || !fileName || !totalChunks) return res.status(400).send('Missing parameters');
  const folderName = (folder || 'others').replace(/[^a-zA-Z0-9-_]/g, '') || 'others';
  const uploadFolder = path.join(baseUploadDir, folderName);
  if (!fs.existsSync(uploadFolder)) fs.mkdirSync(uploadFolder, { recursive: true });

  const finalFileName = Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(fileName);
  const finalPath = path.join(uploadFolder, finalFileName);
  const writeStream = fs.createWriteStream(finalPath);

  try {
    for (let i = 0; i < Number(totalChunks); i++) {
      const chunkPath = path.join(tmpChunkDir, `${uploadId}-${i}`);
      if (!fs.existsSync(chunkPath)) return res.status(400).send(`Chunk ${i} not found`);
      const chunkBuffer = fs.readFileSync(chunkPath);
      await new Promise((resolve, reject) => {
        writeStream.write(chunkBuffer, err => err ? reject(err) : resolve());
      });
      fs.unlinkSync(chunkPath);
    }
    writeStream.end(async () => {
      const mediaDoc = {
        title: title || fileName,
        type: type || (path.extname(fileName).toLowerCase() === '.mp4' ? 'video' : 'image'),
        url: `/uploads/${folderName}/${finalFileName}`,
        isPrivate: isPrivate === 'true',
        folder: folderName,
        category: category || 'Uncategorized',
        createdAt: new Date(),
        downloadCount: 0,
      };
      const result = await mediaCollection.insertOne(mediaDoc);
      console.log('✅ File merged and saved:', mediaDoc.url);
      res.json({ success: true, mediaId: result.insertedId, media: mediaDoc });
    });
  } catch (err) {
    console.error('❌ Merge failed:', err);
    if (!res.headersSent) res.status(500).send('Merge failed');
  }
});

// Media routes
app.get('/media', async (req, res) => {
  try {
    const mediaList = await mediaCollection.find({ isPrivate: false }).toArray();
    res.json(mediaList);
  } catch (err) {
    res.status(500).send('Failed to fetch media');
  }
});

app.get('/my-uploads', async (req, res) => {
  try {
    const mediaList = await mediaCollection.find({}).toArray();
    res.json(mediaList);
  } catch (err) {
    res.status(500).send('Failed to fetch media');
  }
});

app.delete('/media/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const media = await mediaCollection.findOne({ _id: new ObjectId(id) });
    if (!media) return res.status(404).send('Media not found');
    const relativeFilePath = media.url.replace(/^\/uploads\//, '');
    const filePath = path.join(baseUploadDir, relativeFilePath);
    if (fs.existsSync(filePath)) fs.unlink(filePath, err => err && console.warn(err));
    await mediaCollection.deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).send('Failed to delete media');
  }
});

app.patch('/media/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const allowedUpdates = ['title', 'type', 'isPrivate'];
    const updateObj = {};
    for (const key of allowedUpdates) {
      if (key in req.body) updateObj[key] = req.body[key];
    }
    const result = await mediaCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateObj }
    );
    if (result.matchedCount === 0) return res.status(404).send('Media not found');
    res.json({ success: true });
  } catch (err) {
    res.status(500).send('Failed to update media');
  }
});

app.post('/media/download', async (req, res) => {
  try {
    const { mediaId } = req.body;
    if (!mediaId) return res.status(400).send('mediaId is required');
    const media = await mediaCollection.findOne({ _id: new ObjectId(mediaId) });
    if (!media) return res.status(404).send('Media not found');
    const newCount = (media.downloadCount || 0) + 1;
    await mediaCollection.updateOne(
      { _id: new ObjectId(mediaId) },
      { $set: { downloadCount: newCount } }
    );
    res.json({ success: true, downloadCount: newCount });
  } catch (err) {
    res.status(500).send('Failed to track download');
  }
});

// Video Streaming
app.get('/stream/:folder/:filename', (req, res) => {
  const { folder, filename } = req.params;
  const videoPath = path.join(baseUploadDir, folder, filename);
  fs.stat(videoPath, (err, stats) => {
    if (err || !stats) return res.status(404).send('Video not found');
    const fileSize = stats.size;
    const range = req.headers.range;
    if (!range) {
      res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': 'video/mp4' });
      return fs.createReadStream(videoPath).pipe(res);
    }
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : fileSize - 1;
    if (start >= fileSize) return res.status(416).send('Requested range not satisfiable');
    const chunkSize = end - start + 1;
    const stream = fs.createReadStream(videoPath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
    });
    stream.pipe(res);
  });
});

app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
