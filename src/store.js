const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const PREFIX = 'sessions/';

function getClient() {
  return new S3Client({
    endpoint: process.env.SPACES_ENDPOINT,
    region: 'us-east-1', // required by SDK but overridden by endpoint
    credentials: {
      accessKeyId: process.env.SPACES_KEY,
      secretAccessKey: process.env.SPACES_SECRET
    },
    forcePathStyle: false
  });
}

function encrypt(text, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(encoded, keyHex) {
  const [ivHex, authTagHex, encryptedHex] = encoded.split(':');
  const key = Buffer.from(keyHex, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const bucket = () => process.env.SPACES_BUCKET;
const encKey = () => process.env.SESSION_ENCRYPTION_KEY;

async function saveSession(session) {
  // Encrypt tokens before storing; keep rest of config as-is
  const { accessToken, refreshToken, ...rest } = session;
  const payload = {
    ...rest,
    encryptedAccessToken: encrypt(accessToken, encKey()),
    encryptedRefreshToken: refreshToken ? encrypt(refreshToken, encKey()) : null
  };

  const client = getClient();
  await client.send(new PutObjectCommand({
    Bucket: bucket(),
    Key: `${PREFIX}${session.accountId}.json`,
    Body: JSON.stringify(payload),
    ContentType: 'application/json'
  }));
}

async function loadSession(accountId) {
  const client = getClient();
  try {
    const response = await client.send(new GetObjectCommand({
      Bucket: bucket(),
      Key: `${PREFIX}${accountId}.json`
    }));
    const raw = await streamToString(response.Body);
    const data = JSON.parse(raw);

    const accessToken = decrypt(data.encryptedAccessToken, encKey());
    const refreshToken = data.encryptedRefreshToken ? decrypt(data.encryptedRefreshToken, encKey()) : null;
    const { encryptedAccessToken, encryptedRefreshToken, ...rest } = data;
    return { ...rest, accessToken, refreshToken };
  } catch (err) {
    if (err.name === 'NoSuchKey') return null;
    throw err;
  }
}

async function listActiveSessions() {
  const client = getClient();
  try {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: bucket(),
      Prefix: PREFIX
    }));

    const objects = response.Contents || [];
    const sessions = [];

    for (const obj of objects) {
      try {
        const get = await client.send(new GetObjectCommand({ Bucket: bucket(), Key: obj.Key }));
        const raw = await streamToString(get.Body);
        const data = JSON.parse(raw);
        if (data.status === 'running') sessions.push(data);
      } catch {
        // skip corrupt entries
      }
    }

    return sessions;
  } catch {
    return [];
  }
}

async function updateSessionStatus(accountId, status, extra = {}) {
  const session = await loadSession(accountId);
  if (!session) return;
  await saveSession({ ...session, status, ...extra });
}

async function deleteSession(accountId) {
  const client = getClient();
  await client.send(new DeleteObjectCommand({
    Bucket: bucket(),
    Key: `${PREFIX}${accountId}.json`
  }));
}

module.exports = { saveSession, loadSession, listActiveSessions, updateSessionStatus, deleteSession };
