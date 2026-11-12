import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import Groq from "groq-sdk";
import { removeSilenceFromVideo, removeTimeRangesFromVideo, extractCompressedAudio, enhanceVideoAudio, renderVideoClip, composeVideoWithAssets } from "./video-processing.js";
import dotenv from "dotenv";
import DodoPayments from "dodopayments";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Sites autorisés à utiliser le serveur
const ALLOWED = (process.env.ALLOWED_ORIGINS || "https://justevivo.pages.dev")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const SITE_URL = process.env.SITE_URL || "https://justevivo.pages.dev/";

app.set("trust proxy", 1);
app.use(cors({
  origin(origin, cb) {
    cb(null, !origin || ALLOWED.includes(origin));
  }
}));
// Les lots de sous-titres peuvent dépasser 20 Ko (jusqu’à 300 segments).