const express = require("express");
const multer = require("multer");
const fs = require("fs");
const csv = require("csv-parser");
const yts = require("yt-search");
const archiver = require("archiver");
const youtubedl = require("youtube-dl-exec");
const { spawn } = require("child_process");

const app = express();
const upload = multer({ dest: "uploads/" });

// serve index.html + assets
app.use(express.static("."));

// simple in-memory progress tracker (single-user / local use)
let progress = { total: 0, done: 0 };

// normalize user-entered quality (e.g. "128" -> "128K", "best" -> "0")
function normalizeQuality(q) {
  if (!q) return "0"; // default: best VBR
  q = String(q).trim().toLowerCase();

  if (q === "best" || q === "0") return "0"; // yt-dlp: 0 = best VBR
  if (/^\d+$/.test(q)) return q + "K";       // "128" -> "128K"
  if (/^\d+k$/.test(q)) return q.toUpperCase(); // "128k" -> "128K"

  return "0";
}

// turn song title into a safe filename WITH SPACES (no slashes etc)
function makeFileBaseFromTitle(title) {
  return String(title)
    .replace(/[\/\\?%*:|"<>]/g, " ")  // remove path-unsafe chars
    .replace(/\s+/g, " ")            // collapse multiple spaces
    .trim();
}

// helper: get first non-empty field from a list of possible column names
function getField(row, candidates) {
  for (const key of candidates) {
    if (Object.prototype.hasOwnProperty.call(row, key) && row[key] != null) {
      const val = String(row[key]).trim();
      if (val) return val;
    }
  }
  return "";
}

// helper: derive year from multiple possible fields
function getYear(row) {
  // direct year-ish fields
  const directYearRaw = getField(row, [
    "year",
    "Year",
    "release_year",
    "Release Year",
    "ReleaseYear",
    "published_year",
    "Published Year"
  ]);

  if (directYearRaw) {
    const m = String(directYearRaw).match(/\d{4}/);
    if (m) return m[0];
  }

  // album / release date style fields
  const albumDateRaw = getField(row, [
    "albumdate",
    "AlbumDate",
    "album_date",
    "album date",
    "album_release_date",
    "Album Release Date",
    "release_date",
    "Release Date",
    "released_at",
    "Released At",
    "date",
    "Date"
  ]);

  if (albumDateRaw) {
    const m = String(albumDateRaw).match(/\d{4}/);
    if (m) return m[0];
  }

  return "";
}

// helper: get genre from multiple possible fields
function getGenre(row) {
  return getField(row, [
    "genre",
    "Genre",
    "genres",
    "Genres",
    "style",
    "Style",
    "mood",
    "Mood"
  ]);
}

// 1) Download MP3 audio only (no metadata, no thumbnail)
function downloadMP3(url, outputTemplate, userQuality) {
  const audioQuality = normalizeQuality(userQuality);

  return youtubedl(url, {
    extractAudio: true,      // -x / --extract-audio
    audioFormat: "mp3",      // --audio-format mp3
    audioQuality,            // --audio-quality (0-10 or "128K" etc)
    noPlaylist: true,        // --no-playlist
    output: outputTemplate   // -o "<folder>/<file>.%(ext)s"
    // NOTE: no embedThumbnail / addMetadata here
  });
}

// 2) Fetch album art from iTunes (square) and save as JPG
async function fetchAlbumArt(title, artist, tempFolder, fileBase) {
  try {
    const term = `${title} ${artist}`;
    const apiURL = `https://itunes.apple.com/search?term=${encodeURIComponent(
      term
    )}&entity=song&limit=1`;

    const res = await fetch(apiURL);
    if (!res.ok) {
      console.log("iTunes search failed:", res.status);
      return null;
    }

    const json = await res.json();
    if (!json.results || !json.results.length) {
      console.log("No iTunes result for:", term);
      return null;
    }

    // artworkUrl100 is square 100x100; we can often get a larger square:
    // .../100x100bb.jpg -> .../600x600bb.jpg
    let artUrl = json.results[0].artworkUrl100;
    if (artUrl) {
      artUrl = artUrl.replace(/100x100bb\.jpg$/, "600x600bb.jpg");
    }

    const imgRes = await fetch(artUrl);
    if (!imgRes.ok) {
      console.log("Failed to download artwork:", artUrl);
      return null;
    }

    const arrayBuffer = await imgRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const coverPath = `${tempFolder}/${fileBase}_cover.jpg`;
    await fs.promises.writeFile(coverPath, buffer);

    return coverPath;
  } catch (err) {
    console.log("Error fetching album art:", err);
    return null;
  }
}

// 3) Use ffmpeg to apply metadata + optional cover art
function applyMetadataAndCover(mp3Path, coverPath, meta) {
  return new Promise((resolve, reject) => {
    // Make sure the temp file still ends in .mp3 so ffmpeg knows the format
    const tempOut = mp3Path.replace(/\.mp3$/i, ".tagged.mp3");

    const args = [];

    // overwrite output if exists
    args.push("-y");

    // INPUTS
    args.push("-i", mp3Path);        // audio
    if (coverPath) {
      args.push("-i", coverPath);    // cover image
    }

    // MAPS
    if (coverPath) {
      // map audio & image
      args.push("-map", "0:a");
      args.push("-map", "1:v");
    } else {
      args.push("-map", "0:a");
    }

    // copy streams, don't re-encode
    args.push("-c", "copy");

    // ensure proper ID3v2 + write ID3v1 for older players/iPods
    args.push("-id3v2_version", "3");
    args.push("-write_id3v1", "1");

    // metadata from CSV
    if (meta.title)  args.push("-metadata", `title=${meta.title}`);
    if (meta.artist) args.push("-metadata", `artist=${meta.artist}`);
    if (meta.album)  args.push("-metadata", `album=${meta.album}`);
    if (meta.genre)  args.push("-metadata", `genre=${meta.genre}`);

    if (meta.year) {
      // keep it simple: standard "year" field for ID3v2.3
      args.push("-metadata", `year=${meta.year}`);
    }

    // extra tags for cover
    if (coverPath) {
      args.push("-metadata:s:v", "title=Album cover");
      args.push("-metadata:s:v", "comment=Cover (front)");
    }

    // OUTPUT
    args.push(tempOut);

    const ff = spawn("ffmpeg", args);

    ff.stderr.on("data", (d) => {
      // ffmpeg logs – useful for debugging
      process.stderr.write(d.toString());
    });

    ff.on("close", (code) => {
      if (code === 0) {
        // Replace original file with tagged version
        fs.promises
          .rename(tempOut, mp3Path)
          .then(async () => {
            // clean up cover file once we've embedded it
            if (coverPath) {
              try {
                await fs.promises.unlink(coverPath);
              } catch (e) {
                // ignore delete errors
              }
            }
            resolve();
          })
          .catch(reject);
      } else {
        // clean up temp on error
        fs.promises
          .unlink(tempOut)
          .catch(() => {})
          .finally(() => {
            reject(new Error("ffmpeg exited with code " + code));
          });
      }
    });

    ff.on("error", (err) => reject(err));
  });
}

// Simple endpoint for polling progress from frontend
app.get("/progress", (req, res) => {
  res.json(progress);
});

// Handle CSV upload → return ZIP
app.post("/upload", upload.single("csv"), async (req, res) => {
  const csvPath = req.file.path;
  const songs = [];
  const userQuality = req.body.quality || "0";

  fs.createReadStream(csvPath)
    .pipe(csv())
    .on("data", (row) => songs.push(row))
    .on("end", async () => {
      const tempFolder = "mp3s_" + Date.now();
      fs.mkdirSync(tempFolder);

      progress.total = songs.length;
      progress.done = 0;

      for (let s of songs) {
        try {
          // UNIVERSAL FIELD DETECTION

          const title = getField(s, [
            "title",
            "Title",
            "track",
            "Track",
            "track_name",
            "Track Name",
            "trackName",
            "name",
            "Name",
            "song",
            "Song"
          ]);

          const artist = getField(s, [
            "artist",
            "Artist",
            "artists",
            "Artists",
            "artist_name",
            "Artist Name",
            "singer",
            "Singer",
            "performer",
            "Performer"
          ]);

          const album = getField(s, [
            "album",
            "Album",
            "album_name",
            "Album Name",
            "albumName",
            "record",
            "Record",
            "release",
            "Release"
          ]);

          const year = getYear(s);
          const genre = getGenre(s);

          if (!title || !artist) {
            console.log("Skipping row (no title/artist):", s);
            progress.done++;
            continue;
          }

          const query = `${title} ${artist}`;
          console.log("Searching:", query);

          const results = await yts(query);
          const video = results.videos[0];
          if (!video) {
            console.log("No video found for:", query);
            progress.done++;
            continue;
          }

          // filename ONLY from title, with spaces (no underscores)
          const fileBase = makeFileBaseFromTitle(title);

          // yt-dlp will write "<fileBase>.mp3"
          const outputTemplate = `${tempFolder}/${fileBase}.%(ext)s`;
          const mp3Path = `${tempFolder}/${fileBase}.mp3`;

          // 1) download pure audio
          await downloadMP3(video.url, outputTemplate, userQuality);

          // 2) fetch nice square album art (movie/album style)
          const coverPath = await fetchAlbumArt(
            title,
            artist,
            tempFolder,
            fileBase
          );

          // 3) apply metadata from CSV + embed cover
          try {
            await applyMetadataAndCover(mp3Path, coverPath, {
              title,
              artist,
              album,
              year,
              genre
            });
            console.log("Tagged & Downloaded:", mp3Path);
          } catch (tagErr) {
            console.log(
              "Tagging / cover error (keeping audio anyway):",
              tagErr
            );
          }
        } catch (err) {
          console.log("Error downloading:", err);
        } finally {
          progress.done++;
        }
      }

      // when we're done, reset progress after a little while (optional)
      setTimeout(() => {
        progress.total = 0;
        progress.done = 0;
      }, 60_000);

      // Create ZIP to send to user
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", "attachment; filename=songs.zip");

      const zip = archiver("zip");
      zip.pipe(res);
      zip.directory(tempFolder, false);
      zip.finalize();
    });
});

app.listen(3000, () => console.log("Server running at http://localhost:3000"));
