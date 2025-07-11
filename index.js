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


// Base upload directory
const baseUploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(baseUploadDir)) {
  fs.mkdirSync(baseUploadDir);
  console.log('Uploads base folder created');
}
app.use('/uploads', express.static(baseUploadDir));

// Temporary chunk storage folder
const tmpChunkDir = path.join(__dirname, 'tmp_chunks');
if (!fs.existsSync(tmpChunkDir)) fs.mkdirSync(tmpChunkDir);

// MongoDB setup
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.mojyanw.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let mediaCollection;

async function connectDB() {
  await client.connect();
  const db = client.db('snapVaultDB');
  mediaCollection = db.collection('media');
  console.log('Connected to MongoDB');
}
connectDB().catch(console.error);

// Multer config for normal uploads (single or multiple)
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    let folder = req.body.folder || 'others';
    folder = folder.replace(/[^a-zA-Z0-9-_]/g, '') || 'others';
    const uploadPath = path.join(baseUploadDir, folder);
    fs.mkdir(uploadPath, { recursive: true }, (err) => {
      if (err) return cb(err);
      cb(null, uploadPath);
    });
  },
  filename: function (req, file, cb) {
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueName + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 * 1024 }, // 20GB limit per file
});

// === ROUTES ===

// Basic server test
app.get('/', (req, res) => {
  res.send('snap-vault-server is running');
});

// --------- Normal uploads -----------

// Upload single media
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

// Upload multiple media
app.post('/media/multi', upload.array('media'), async (req, res) => {
  try {
    const { title, isPrivate, folder, uploaderName, category } = req.body;
    const categoryName = (category?.trim() || 'Uncategorized');
    if (!req.files || req.files.length === 0) {
      return res.status(400).send('No files uploaded');
    }

    const folderName = (folder || 'others').replace(/[^a-zA-Z0-9-_]/g, '') || 'others';

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
  } catch (error) {
    console.error(error);
    res.status(500).send('Failed to upload files');
  }
});

// --------- Chunk upload (for large files) -----------

// Multer for chunk uploads
const chunkStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, tmpChunkDir);
  },
  filename: (req, file, cb) => {
    const { uploadId, chunkIndex } = req.body;
    cb(null, `${uploadId}-${chunkIndex}`);
  }
});
const chunkUpload = multer({ storage: chunkStorage });

// Upload chunk
app.post('/upload/chunk', chunkUpload.single('chunk'), (req, res) => {
  if (!req.file) return res.status(400).send('No chunk uploaded');
  res.json({ success: true });
});

const chunkUploadParser = multer().none(); // for parsing FormData with no files

app.post('/upload/complete', chunkUploadParser, async (req, res) => {
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

  if (!uploadId || !fileName || !totalChunks) {
    return res.status(400).send('Missing parameters');
  }

  const folderName = (folder || 'others').replace(/[^a-zA-Z0-9-_]/g, '') || 'others';
  const uploadFolder = path.join(baseUploadDir, folderName);
  if (!fs.existsSync(uploadFolder)) fs.mkdirSync(uploadFolder, { recursive: true });

  const finalFileName =
    Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(fileName);
  const finalPath = path.join(uploadFolder, finalFileName);

  const writeStream = fs.createWriteStream(finalPath);

  writeStream.on('error', (err) => {
    console.error('WriteStream error:', err);
    if (!res.headersSent) {
      res.status(500).send('Error writing file');
    }
  });

  try {
    for (let i = 0; i < Number(totalChunks); i++) {
      const chunkPath = path.join(tmpChunkDir, `${uploadId}-${i}`);
      if (!fs.existsSync(chunkPath)) {
        return res.status(400).send(`Chunk ${i} not found`);
      }
      const chunkBuffer = fs.readFileSync(chunkPath);

      await new Promise((resolve, reject) => {
        writeStream.write(chunkBuffer, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      fs.unlinkSync(chunkPath); // cleanup
    }

    writeStream.end();

    writeStream.on('finish', async () => {
      try {
        const mediaDoc = {
          title: title || fileName,
          type: type || (path.extname(fileName).toLowerCase() === '.mp4' ? 'video' : 'image'),
          url: `/uploads/${folderName}/${finalFileName}`,
          isPrivate: isPrivate === 'true' || false,
          folder: folderName,
          category: category || 'Uncategorized',
          createdAt: new Date(),
          downloadCount: 0,
        };

        const result = await mediaCollection.insertOne(mediaDoc);
        res.json({ success: true, mediaId: result.insertedId, media: mediaDoc });
      } catch (dbErr) {
        console.error('DB insert error:', dbErr);
        res.status(500).send('Failed to save media metadata');
      }
    });
  } catch (err) {
    console.error('Error merging chunks:', err);
    if (!res.headersSent) {
      res.status(500).send('Failed to merge chunks');
    }
  }
});



// --------- Media fetch -----------

// Get all public media
app.get('/media', async (req, res) => {
  try {
    const mediaList = await mediaCollection.find({ isPrivate: false }).toArray();
    res.json(mediaList);
  } catch (err) {
    res.status(500).send('Failed to fetch media');
  }
});

// Get all uploads (admin/all)
app.get('/my-uploads', async (req, res) => {
  try {
    const mediaList = await mediaCollection.find({}).toArray();
    res.json(mediaList);
  } catch (err) {
    res.status(500).send('Failed to fetch media');
  }
});

// --------- Media delete -----------

app.delete('/media/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const media = await mediaCollection.findOne({ _id: new ObjectId(id) });
    if (!media) return res.status(404).send('Media not found');

    const relativeFilePath = media.url.replace(/^\/uploads\//, '');
    const filePath = path.join(baseUploadDir, relativeFilePath);

    if (fs.existsSync(filePath)) {
      fs.unlink(filePath, (err) => {
        if (err) console.warn('File deletion error:', err);
      });
    } else {
      console.warn('File not found for deletion:', filePath);
    }

    await mediaCollection.deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to delete media');
  }
});

// --------- Media update -----------

app.patch('/media/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const updateData = req.body;
    const allowedUpdates = ['title', 'type', 'isPrivate'];
    const updateObj = {};

    allowedUpdates.forEach(field => {
      if (field in updateData) updateObj[field] = updateData[field];
    });

    const result = await mediaCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateObj }
    );

    if (result.matchedCount === 0) return res.status(404).send('Media not found');
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to update media');
  }
});

// --------- Download count tracking -----------

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
    console.error('Download tracking error:', err);
    res.status(500).send('Failed to track download');
  }
});

// --------- Video streaming with Range requests -----------

app.get('/stream/:folder/:filename', (req, res) => {
  const { folder, filename } = req.params;
  const videoPath = path.join(baseUploadDir, folder, filename);

  fs.stat(videoPath, (err, stats) => {
    if (err || !stats) return res.status(404).send('Video not found');

    const fileSize = stats.size;
    const range = req.headers.range;

    if (!range) {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
      });
      return fs.createReadStream(videoPath).pipe(res);
    }

    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (start >= fileSize) {
      res.status(416).send('Requested range not satisfiable\n' + start + ' >= ' + fileSize);
      return;
    }

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

// Start server
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
