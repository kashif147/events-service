const {
  blobServiceClient,
  containerName,
  isConfigured,
  sharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
} = require("../config/azure.storage");

// The storage account has anonymous public access disabled, so a bare blob
// URL 404s in a browser <img> tag - every readable URL handed to the
// frontend must carry a SAS token. Event images are shown indefinitely
// (not downloaded once like payment forms), so this is issued with a long
// expiry rather than the short-lived one used elsewhere.
const READ_SAS_YEARS = 10;

async function uploadToBlob(blobPath, buffer, contentType, downloadFileName = null) {
  if (!isConfigured) {
    throw new Error(
      "Azure Storage is not configured. Set AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_ACCOUNT and AZURE_STORAGE_KEY."
    );
  }
  const nameForDisposition = downloadFileName || blobPath.split("/").pop() || "file";
  const asciiFallback =
    nameForDisposition
      .replace(/[\r\n"]/g, "_")
      .replace(/[^\x20-\x7E]/g, "_")
      .slice(0, 200) || "file";

  const container = blobServiceClient.getContainerClient(containerName);
  await container.createIfNotExists();
  const blockBlob = container.getBlockBlobClient(blobPath);
  await blockBlob.uploadData(buffer, {
    blobHTTPHeaders: {
      blobContentType: contentType || "application/octet-stream",
      blobContentDisposition: `inline; filename="${asciiFallback}"`,
    },
  });
  return blockBlob.url;
}

function getLongLivedReadUrl(blobPath) {
  if (!isConfigured || !sharedKeyCredential || !blobPath) return null;
  const container = blobServiceClient.getContainerClient(containerName);
  const blobClient = container.getBlockBlobClient(blobPath);
  const expiresOn = new Date(Date.now() + READ_SAS_YEARS * 365 * 24 * 60 * 60 * 1000);
  const sas = generateBlobSASQueryParameters(
    {
      containerName,
      blobName: blobPath,
      permissions: BlobSASPermissions.parse("r"),
      expiresOn,
    },
    sharedKeyCredential
  ).toString();
  return `${blobClient.url}?${sas}`;
}

module.exports = {
  uploadToBlob,
  getLongLivedReadUrl,
  isConfigured,
};
