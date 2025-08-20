import { respondWithJSON } from "./json";
import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { getAssetDiskPath, getAssetPath } from "./assets";
import { unlink } from "fs/promises";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const UPLOAD_LIMIT = 1 << 30; // 1 GiB

  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }
  if (video.userID !== userID) {
    throw new UserForbiddenError("Not authorized to update this video");
  }

  const formData = await req.formData();
  const uploadedVideoFile = formData.get("video");
  if (!(uploadedVideoFile instanceof File)) {
    throw new BadRequestError("Video file missing");
  }

  if (uploadedVideoFile.size > UPLOAD_LIMIT) {
    throw new BadRequestError("File size exceeds upload limit");
  }

  const videoType = uploadedVideoFile.type;
  if (videoType !== "video/mp4") {
    throw new BadRequestError("Unsupported media type");
  }

  const assetPath = getAssetPath(videoType);
  const assetDiskPath = getAssetDiskPath(cfg, assetPath);

  // Write uploaded video to disk
  await Bun.write(assetDiskPath, uploadedVideoFile);

  try {
    // Upload video from disk to S3, using Bun.file for binary data
    const s3file = cfg.s3Client.file(assetPath);
    await s3file.write(Bun.file(assetDiskPath), {
      type: videoType,
    });

    // Update video URL
    video.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${assetPath}`;
    updateVideo(cfg.db, video);
    return respondWithJSON(200, video);
  } finally {
    // Always remove the temp file from disk
    await unlink(assetDiskPath);
  }
}
