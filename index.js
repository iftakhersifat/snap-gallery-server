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
app.use(express.urlencoded({ extended: true, limit: '500mb' }));
app.use(express.json({ limit: '500mb' }));

// Base upload dir
const baseUploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(baseUploadDir)) fs.mkdirSync(baseUploadDir);
app.use('/uploads', express.static(baseUploadDir));

// Temp chunk folder
const tmpChunkDir = path.join(__dirname, 'tmp_chunks');
if (!fs.existsSync(tmpChunkDir)) fs.mkdirSync(tmpChunkDir);

// MongoDB
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.mojyanw.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const client = new MongoClient(uri, { serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true } });
let mediaCollection;
async function connectDB() {
  await client.connect();
  const db = client.db('snapVaultDB');
  mediaCollection = db.collection('media');
  console.log('Connected to MongoDB');
}
connectDB().catch(console.error);

// Normal upload storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const folder = (req.body.folder || 'others').replace(/[^a-zA-Z0-9-_]/g, '') || 'others';
    const uploadPath = path.join(baseUploadDir, folder);
    fs.mkdir(uploadPath, { recursive: true }, err => cb(err, uploadPath));
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueName + path.extname(file.originalname));
  },
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 * 1024 } });

// Routes
app.get('/', (req, res) => res.send('snap-vault-server is running'));

// Chunk Upload
const chunkStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, tmpChunkDir),
  filename: (req, file, cb) => {
    const { uploadId, chunkIndex } = req.body;
    if (!uploadId || chunkIndex === undefined) return cb(new Error('Missing uploadId or chunkIndex'));
    cb(null, `${uploadId}-${chunkIndex}`);
  }
});
const chunkUpload = multer({ storage: chunkStorage });

app.post('/upload/chunk', chunkUpload.single('chunk'), (req, res) => {
  if (!req.file) return res.status(400).send('No chunk uploaded');
  console.log(`✅ Received chunk ${req.body.chunkIndex} for ${req.body.uploadId}`);
  res.json({ success: true });
});

const uploadNone = multer();
app.post('/upload/complete', uploadNone.none(), async (req, res) => {
  const {
    uploadId,
    fileName,
    totalChunks,
    title,
    type,
    isPrivate,
    folder,
    category
  } = req.body;

  if (!uploadId || !fileName || !totalChunks) return res.status(400).send('Missing parameters');

  const folderName = (folder || 'others').replace(/[^a-zA-Z0-9-_]/g, '') || 'others';
  const uploadFolder = path.join(baseUploadDir, folderName);
  if (!fs.existsSync(uploadFolder)) fs.mkdirSync(uploadFolder, { recursive: true });

  const finalFileName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(fileName)}`;
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
        type: type || 'video',
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
    console.error('❌ Merge error:', err);
    if (!res.headersSent) res.status(500).send('Merge failed');
  }
});

// Start
app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
