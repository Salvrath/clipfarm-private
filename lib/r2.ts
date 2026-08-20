import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  S3Client,
  UploadPartCommand,
  type CompletedPart,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const R2_BUCKET = process.env.R2_BUCKET?.trim() || "clipfarm-sources";
export const R2_PART_SIZE = 64 * 1024 * 1024;
export const R2_MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
const PRESIGNED_PART_TTL_SECONDS = 6 * 60 * 60;

function getR2Client() {
  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2 storage is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY in Vercel.",
    );
  }

  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

export async function createMultipartUpload(key: string, contentType: string) {
  const client = getR2Client();
  const response = await client.send(new CreateMultipartUploadCommand({
    Bucket: R2_BUCKET,
    Key: key,
    ContentType: contentType,
  }));
  if (!response.UploadId) throw new Error("R2 did not return a multipart upload ID.");
  return response.UploadId;
}

export async function createPartUploadUrls(key: string, uploadId: string, partCount: number) {
  if (!Number.isInteger(partCount) || partCount < 1 || partCount > 10_000) {
    throw new Error("Invalid R2 multipart part count.");
  }

  const client = getR2Client();
  return Promise.all(Array.from({ length: partCount }, async (_, index) => {
    const partNumber = index + 1;
    const url = await getSignedUrl(
      client,
      new UploadPartCommand({
        Bucket: R2_BUCKET,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: PRESIGNED_PART_TTL_SECONDS },
    );
    return { partNumber, url };
  }));
}

export async function completeMultipartUpload(
  key: string,
  uploadId: string,
  parts: CompletedPart[],
) {
  const client = getR2Client();
  await client.send(new CompleteMultipartUploadCommand({
    Bucket: R2_BUCKET,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: { Parts: parts },
  }));
}

export async function abortMultipartUpload(key: string, uploadId: string) {
  const client = getR2Client();
  await client.send(new AbortMultipartUploadCommand({
    Bucket: R2_BUCKET,
    Key: key,
    UploadId: uploadId,
  }));
}

export async function deleteR2Object(key: string) {
  const client = getR2Client();
  await client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
}
