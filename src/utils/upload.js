const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

// Same DATA_DIR used by db.js, so the database AND every uploaded image live
// under one single mount path -- required because Render (and most PaaS)
// only allow ONE persistent disk per service.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..');
const UPLOADS_ROOT = path.join(DATA_DIR, 'uploads');

function makeUploader(subfolder, opts) {
  const perUser = opts && opts.perUser;
  fs.mkdirSync(path.join(UPLOADS_ROOT, subfolder), { recursive: true });

  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      // Per-user uploads get their own folder (uploads/<category>/<userId>/)
      // instead of one giant shared folder — keeps the file system fast to
      // browse even with thousands of users, and makes it obvious in File
      // Storage Management whose file is whose.
      if (perUser && req.user && req.user.id) {
        const dest = path.join(UPLOADS_ROOT, subfolder, String(req.user.id));
        fs.mkdirSync(dest, { recursive: true });
        return cb(null, dest);
      }
      cb(null, path.join(UPLOADS_ROOT, subfolder));
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, crypto.randomBytes(16).toString('hex') + ext);
    },
  });

  return multer({
    storage,
    limits: { fileSize: MAX_SIZE },
    fileFilter: (req, file, cb) => {
      if (!ALLOWED_MIME.includes(file.mimetype)) {
        return cb(new Error('Only PNG, JPG, or WEBP images are allowed.'));
      }
      cb(null, true);
    },
  });
}

const ALLOWED_MEDIA_MIME = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime'];
const MAX_MEDIA_SIZE = 50 * 1024 * 1024; // 50MB — event videos are bigger than a QR code image

function makeMediaUploader(subfolder) {
  const destination = path.join(UPLOADS_ROOT, subfolder);
  fs.mkdirSync(destination, { recursive: true });

  const storage = multer.diskStorage({
    destination,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || (file.mimetype.startsWith('video') ? '.mp4' : '.jpg');
      cb(null, crypto.randomBytes(16).toString('hex') + ext);
    },
  });

  return multer({
    storage,
    limits: { fileSize: MAX_MEDIA_SIZE },
    fileFilter: (req, file, cb) => {
      if (!ALLOWED_MEDIA_MIME.includes(file.mimetype)) {
        return cb(new Error('Only images (PNG/JPG/WEBP) or videos (MP4/WEBM/MOV) are allowed.'));
      }
      cb(null, true);
    },
  });
}

const ALLOWED_AUDIO_MIME = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/x-wav'];
const MAX_AUDIO_SIZE = 15 * 1024 * 1024; // 15MB — background loops are longer than a QR code image

function makeAudioUploader(subfolder) {
  const destination = path.join(UPLOADS_ROOT, subfolder);
  fs.mkdirSync(destination, { recursive: true });

  const storage = multer.diskStorage({
    destination,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.mp3';
      cb(null, crypto.randomBytes(16).toString('hex') + ext);
    },
  });

  return multer({
    storage,
    limits: { fileSize: MAX_AUDIO_SIZE },
    fileFilter: (req, file, cb) => {
      if (!ALLOWED_AUDIO_MIME.includes(file.mimetype)) {
        return cb(new Error('Only MP3, WAV, or OGG audio files are allowed.'));
      }
      cb(null, true);
    },
  });
}

module.exports = { makeUploader, makeAudioUploader, makeMediaUploader, UPLOADS_ROOT };
