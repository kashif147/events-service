const {
  blobServiceClient,
  containerName,
  isConfigured,
} = require("../config/azure.storage");

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

module.exports = {
  uploadToBlob,
  isConfigured,
};
