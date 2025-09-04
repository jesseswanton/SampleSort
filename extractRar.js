

//DON'T UPDATE THIS FILE

const fs = require("fs");
const path = require("path");
const { createExtractorFromFile } = require("node-unrar-js");

async function extractRarArchive(file, destination, keepArchive = true) {
  const extractedFiles = [];

  try {
    if (!fs.existsSync(destination)) fs.mkdirSync(destination, { recursive: true });

    const extractor = await createExtractorFromFile({ filepath: file, targetPath: destination });

    // Extract files
    const list = extractor.extract();
    if (!list.files) return extractedFiles;

    // Recursively flatten if there are nested single folders
    function flattenSingleFolders(folderPath) {
        let items = fs.readdirSync(folderPath);
      
        while (items.length === 1 && fs.statSync(path.join(folderPath, items[0])).isDirectory()) {
          const singleFolder = path.join(folderPath, items[0]);
          const innerFiles = fs.readdirSync(singleFolder);
      
          for (const fileName of innerFiles) {
            const oldPath = path.join(singleFolder, fileName);
            const newPath = path.join(folderPath, fileName);
            fs.renameSync(oldPath, newPath);
          }
      
          fs.rmdirSync(singleFolder);
          items = fs.readdirSync(folderPath);
        }
      }

    flattenSingleFolders(destination);

    // Track all extracted files (full paths)
    for (const f of list.files) {
        if (!f.fileHeader.flags.directory) {
            const outPath = path.join(destination, f.fileHeader.name);
            extractedFiles.push(outPath);
        }
        }

    if (!keepArchive) fs.unlinkSync(file);

  } catch (err) {
    console.error(err);
    throw err;
  }

  return extractedFiles;
}

module.exports = { extractRarArchive };