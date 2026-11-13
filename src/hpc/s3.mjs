// S3 client for Allas (https://docs.csc.fi/data/Allas/): where page images wait for the Slurm job
// and where its results appear. One bucket, every run under its own prefix.

import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';

export const DEFAULT_ENDPOINT = 'https://a3s.fi';

/**
 * @param {object} options
 * @param {string} options.accessKey from `rclone config show s3allas-<project>` on Roihu
 * @param {string} options.secretKey
 * @param {string} options.bucket
 * @param {string} [options.endpoint]
 */
export function createS3({ accessKey, secretKey, bucket, endpoint = DEFAULT_ENDPOINT }) {
  if (!accessKey || !secretKey) throw new Error('Allas S3 keys are missing: set ALLAS_ACCESS_KEY and ALLAS_SECRET_KEY');
  const client = new S3Client({
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    // Allas (Ceph) rejects the streaming checksums newer SDKs add by default (MissingContentLength)
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

  return {
    bucket,

    /**
     * Creates the bucket when it is not there yet. A refusal (HTTP 401/403: wrong keys, Allas not
     * enabled for the project, bucket of someone else) has `statusCode` on the error.
     */
    async ensureBucket() {
      const refused = (error, what) => {
        const status = error?.$metadata?.httpStatusCode;
        const wrapped = new Error(`Allas ${what} (HTTP ${status || 'no answer'})`);
        wrapped.statusCode = status;
        return wrapped;
      };
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch (error) {
        if (error?.$metadata?.httpStatusCode === 403 || error?.$metadata?.httpStatusCode === 401) {
          throw refused(error, `refused the keys, or the bucket ${bucket} belongs to someone else`);
        }
        try {
          await client.send(new CreateBucketCommand({ Bucket: bucket }));
        } catch (createError) {
          throw refused(createError, `could not create the bucket ${bucket}: wrong keys, Allas is not enabled for the project, or its quota is used`);
        }
      }
    },

    async putFile(key, filePath) {
      const { size } = await fs.promises.stat(filePath);
      // Content-Length must be known: Allas does not take chunked uploads
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: fs.createReadStream(filePath), ContentLength: size }));
    },

    async putText(key, text) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: Buffer.from(text) }));
    },

    /** Every key under a prefix: { key, size }. */
    async list(prefix) {
      const found = [];
      let token;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        for (const object of page.Contents || []) found.push({ key: object.Key, size: object.Size });
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return found;
    },

    async getToFile(key, filePath) {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      await pipeline(response.Body, fs.createWriteStream(filePath));
    },

    async getText(key) {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return await response.Body.transformToString();
      } catch (error) {
        if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
    },

    async deletePrefix(prefix) {
      const objects = await this.list(prefix);
      for (let i = 0; i < objects.length; i += 1000) {
        await client.send(new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects.slice(i, i + 1000).map(({ key }) => ({ Key: key })), Quiet: true },
        }));
      }
      return objects.length;
    },
  };
}
