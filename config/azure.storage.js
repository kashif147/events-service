const {
  BlobServiceClient,
  StorageSharedKeyCredential,
} = require("@azure/storage-blob");

const connectionString = (process.env.AZURE_STORAGE_CONNECTION_STRING || "")
  .replace(/\s+/g, " ")
  .trim();
const accountName = (process.env.AZURE_STORAGE_ACCOUNT || "").trim();
const accountKey = (process.env.AZURE_STORAGE_KEY || "")
  .replace(/\r?\n/g, "")
  .trim();
const containerName = (
  process.env.AZURE_STORAGE_CONTAINER ||
  process.env.AZURE_STORAGE_CONTAINER_NAME ||
  "event-images"
).trim();

let blobServiceClient = null;
let sharedKeyCredential = null;
let resolvedAccountName = accountName;

if (connectionString) {
  blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
  const nameMatch = connectionString.match(/AccountName=([^;]+)/);
  resolvedAccountName = nameMatch ? nameMatch[1].trim() : accountName;
} else if (accountName && accountKey) {
  sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);
  blobServiceClient = new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    sharedKeyCredential
  );
}

const isConfigured = Boolean(blobServiceClient && containerName);

module.exports = {
  blobServiceClient,
  containerName,
  accountName: resolvedAccountName,
  isConfigured,
};
