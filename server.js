import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import Groq from "groq-sdk";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const UPLOAD_DIR = "/tmp/justevivo-uploads/";
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".mp4";
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }
});

// Vérifier que le serveur fonctionne
app.get("/", (req, res) => {
  res.json({
    message: "Bienvenue sur le serveur JUSTEVIVO !",
    status: "En fonctionnement"
  });
});

// Transcrire une vidéo ou un fichier audio
app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  if (!process.env.GROQ_API_KEY) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(503).json({
      error: "La clé API Groq n'est pas encore configurée."
    });
  }

  if (!req.file) {
    return res.status(400).json({
      error: "Veuillez envoyer un fichier audio ou vidéo."
    });
  }

  console.log(
    "Fichier reçu :",
    req.file.originalname,
    req.file.mimetype,
    req.file.size,
    "octets"
  );

  try {
    const groq = new Groq({
      apiKey: process.env.GROQ_API_KEY
    });

    const result = await groq.audio.transcriptions.create({
      file: fs.createReadStream(req.file.path),
      model: "whisper-large-v3-turbo",
      response_format: "verbose_json",
      timestamp_granularities: ["segment"]
    });

    res.json({
      success: true,
      text: result.text,
      language: result.language,
      duration: result.duration,
      segments: result.segments
    });

  } catch (error) {
    console.error("Erreur de transcription :", error.message);
    res.status(500).json({
      error: "La transcription a échoué. Réessayez."
    });

  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

app.listen(PORT, () => {
  console.log(`JUSTEVIVO fonctionne sur le port ${PORT}`);
});
