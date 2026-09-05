const express = require('express')
const multer = require('multer')
const fs = require('fs')
const csv = require('csv-parser')
const yts = require('yt-search')
const archiver = require('archiver')
const youtubedl = require('youtube-dl-exec')
const path = require('path')
const { spawn } = require('child_process')

const app = express()
const upload = multer({ dest: 'uploads/' })

// serve index.html + assets
app.use(express.static('.'))

// simple in-memory progress tracker (single-user / local use)
const progress = { total: 0, done: 0 }

// YouTube keeps changing how it serves audio, so a yt-dlp binary that is a few
// months old starts failing every download with "HTTP Error 403: Forbidden".
// Self-update the bundled binary on boot; downloads wait for this to settle so
// we never swap the binary out from under a running download.
const ytDlpPath = youtubedl.constants.YOUTUBE_DL_PATH

function updateYtDlp () {
  return new Promise((resolve) => {
    const proc = spawn(ytDlpPath, ['-U'])
    let out = ''

    proc.stdout.on('data', (d) => (out += d.toString()))
    proc.stderr.on('data', (d) => (out += d.toString()))

    // don't let a hanging network call block the server forever
    const timer = setTimeout(() => proc.kill(), 60_000)

    proc.on('close', () => {
      clearTimeout(timer)
      const summary = out
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^(Latest version|Updated yt-dlp|yt-dlp is up to date)/.test(l))
      console.log(summary.length ? summary.join('\n') : 'yt-dlp update check done')
      resolve()
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      console.log('Could not update yt-dlp, using the bundled version:', err.message)
      resolve()
    })
  })
}

const ytDlpReady = updateYtDlp()

// normalize user-entered quality (e.g. "128" -> "128K", "best" -> "0")
function normalizeQuality (q) {
  if (!q) return '0' // default: best VBR
  q = String(q).trim().toLowerCase()

  if (q === 'best' || q === '0') return '0' // yt-dlp: 0 = best VBR
  if (/^\d+$/.test(q)) return q + 'K' // "128" -> "128K"
  if (/^\d+k$/.test(q)) return q.toUpperCase() // "128k" -> "128K"

  return '0'
}

// turn song title into a safe filename WITH SPACES (no slashes etc)
function makeFileBaseFromTitle (title) {
  return String(title)
    .replace(/[\/\\?%*:|"<>]/g, ' ') // remove path-unsafe chars
    .replace(/\s+/g, ' ') // collapse multiple spaces
    .trim()
}

// move the finished MP3 to "<title>.mp3", adding " (2)", " (3)"… on collisions
async function renameToUniqueTitle (mp3Path, tempFolder, fileBase) {
  let candidate = path.join(tempFolder, `${fileBase}.mp3`)
  let n = 2

  while (fs.existsSync(candidate)) {
    candidate = path.join(tempFolder, `${fileBase} (${n}).mp3`)
    n++
  }

  await fs.promises.rename(mp3Path, candidate)
  return candidate
}

// short, human-readable reason for the failure list we send back to the browser
function describeRowFailure (row, err) {
  const label = Object.values(row).slice(0, 2).join(' ').trim() || 'Unknown track'
  const raw = String(err.stderr || err.message || err)
  const reason =
    raw
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('ERROR:')) || raw.split('\n')[0]

  return `${label} — ${reason.replace(/^ERROR:\s*/, '')}`
}

// strip case and separators so "Album Date", "album_date" and "albumdate"
// all collapse to the same key (also drops any BOM left on the first header)
function normalizeKey (key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '')
}

// helper: get first non-empty field from a list of possible column names
function getField (row, candidates) {
  const byKey = new Map()
  for (const key of Object.keys(row)) {
    const normalized = normalizeKey(key)
    if (!byKey.has(normalized)) byKey.set(normalized, row[key])
  }

  for (const candidate of candidates) {
    const raw = byKey.get(normalizeKey(candidate))
    if (raw != null) {
      const val = String(raw).trim()
      if (val) return val
    }
  }
  return ''
}

// helper: derive year from multiple possible fields
function getYear (row) {
  // direct year-ish fields
  const directYearRaw = getField(row, [
    'year',
    'Year',
    'release_year',
    'Release Year',
    'ReleaseYear',
    'published_year',
    'Published Year'
  ])

  if (directYearRaw) {
    const m = String(directYearRaw).match(/\d{4}/)
    if (m) return m[0]
  }

  // album / release date style fields
  const albumDateRaw = getField(row, [
    'albumdate',
    'AlbumDate',
    'album_date',
    'album date',
    'album_release_date',
    'Album Release Date',
    'release_date',
    'Release Date',
    'released_at',
    'Released At',
    'date',
    'Date'
  ])

  if (albumDateRaw) {
    const m = String(albumDateRaw).match(/\d{4}/)
    if (m) return m[0]
  }

  return ''
}

// helper: get genre from multiple possible fields
function getGenre (row) {
  return getField(row, [
    'genre',
    'Genre',
    'genres',
    'Genres',
    'style',
    'Style',
    'mood',
    'Mood'
  ])
}

// 1) Download MP3 audio only (no metadata, no thumbnail)
function downloadMP3 (url, outputTemplate, userQuality) {
  const audioQuality = normalizeQuality(userQuality)

  return youtubedl(url, {
    extractAudio: true, // -x / --extract-audio
    audioFormat: 'mp3', // --audio-format mp3
    audioQuality, // --audio-quality (0-10 or "128K" etc)
    noPlaylist: true, // --no-playlist
    output: outputTemplate // -o "<folder>/<file>.%(ext)s"
    // NOTE: no embedThumbnail / addMetadata here
  })
}

// 2) Fetch album art from iTunes (square) and save as JPG
async function fetchAlbumArt (title, artist, tempFolder, fileBase) {
  try {
    const term = `${title} ${artist}`
    const apiURL = `https://itunes.apple.com/search?term=${encodeURIComponent(
      term
    )}&entity=song&limit=1`

    const res = await fetch(apiURL)
    if (!res.ok) {
      console.log('iTunes search failed:', res.status)
      return null
    }

    const json = await res.json()
    if (!json.results || !json.results.length) {
      console.log('No iTunes result for:', term)
      return null
    }

    // artworkUrl100 is square 100x100; we can often get a larger square:
    // .../100x100bb.jpg -> .../600x600bb.jpg
    let artUrl = json.results[0].artworkUrl100
    if (artUrl) {
      artUrl = artUrl.replace(/100x100bb\.jpg$/, '600x600bb.jpg')
    }

    const imgRes = await fetch(artUrl)
    if (!imgRes.ok) {
      console.log('Failed to download artwork:', artUrl)
      return null
    }

    const arrayBuffer = await imgRes.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    const coverPath = `${tempFolder}/${fileBase}_cover.jpg`
    await fs.promises.writeFile(coverPath, buffer)

    return coverPath
  } catch (err) {
    console.log('Error fetching album art:', err)
    return null
  }
}

// 3) Use ffmpeg to apply metadata + optional cover art
function applyMetadataAndCover (mp3Path, coverPath, meta) {
  return new Promise((resolve, reject) => {
    // Make sure the temp file still ends in .mp3 so ffmpeg knows the format
    const tempOut = mp3Path.replace(/\.mp3$/i, '.tagged.mp3')

    const args = []

    // overwrite output if exists
    args.push('-y')

    // INPUTS
    args.push('-i', mp3Path) // audio
    if (coverPath) {
      args.push('-i', coverPath) // cover image
    }

    // MAPS
    if (coverPath) {
      // map audio & image
      args.push('-map', '0:a')
      args.push('-map', '1:v')
    } else {
      args.push('-map', '0:a')
    }

    // copy streams, don't re-encode
    args.push('-c', 'copy')

    // ensure proper ID3v2 + write ID3v1 for older players/iPods
    args.push('-id3v2_version', '3')
    args.push('-write_id3v1', '1')

    // metadata from CSV
    if (meta.title) args.push('-metadata', `title=${meta.title}`)
    if (meta.artist) args.push('-metadata', `artist=${meta.artist}`)
    if (meta.album) args.push('-metadata', `album=${meta.album}`)
    if (meta.genre) args.push('-metadata', `genre=${meta.genre}`)

    if (meta.year) {
      // ffmpeg's mp3 muxer maps "date" onto the ID3 year frame (TYER/TDRC);
      // a bare "year=" key is dropped, so write both for wide player support
      args.push('-metadata', `date=${meta.year}`)
      args.push('-metadata', `TYER=${meta.year}`)
    }

    // extra tags for cover
    if (coverPath) {
      args.push('-metadata:s:v', 'title=Album cover')
      args.push('-metadata:s:v', 'comment=Cover (front)')
    }

    // OUTPUT
    args.push(tempOut)

    const ff = spawn('ffmpeg', args)

    ff.stderr.on('data', (d) => {
      // ffmpeg logs – useful for debugging
      process.stderr.write(d.toString())
    })

    ff.on('close', (code) => {
      if (code === 0) {
        // Replace original file with tagged version
        fs.promises
          .rename(tempOut, mp3Path)
          .then(async () => {
            // clean up cover file once we've embedded it
            if (coverPath) {
              try {
                await fs.promises.unlink(coverPath)
              } catch (e) {
                // ignore delete errors
              }
            }
            resolve()
          })
          .catch(reject)
      } else {
        // clean up temp on error
        fs.promises
          .unlink(tempOut)
          .catch(() => {})
          .finally(() => {
            reject(new Error('ffmpeg exited with code ' + code))
          })
      }
    })

    ff.on('error', (err) => reject(err))
  })
}

// Simple endpoint for polling progress from frontend
app.get('/progress', (req, res) => {
  res.json(progress)
})

// Handle CSV upload → return ZIP
app.post('/upload', upload.single('csv'), async (req, res) => {
  const csvPath = req.file.path
  const songs = []
  const userQuality = req.body.quality || '0'

  fs.createReadStream(csvPath)
    .pipe(csv())
    .on('data', (row) => songs.push(row))
    .on('end', async () => {
      const tempFolder = 'mp3s_' + Date.now()
      fs.mkdirSync(tempFolder)

      progress.total = songs.length
      progress.done = 0

      // wait for the yt-dlp update check before touching the binary
      await ytDlpReady

      let trackNumber = 0
      const failures = []

      for (const s of songs) {
        trackNumber++
        try {
          // UNIVERSAL FIELD DETECTION

          const title = getField(s, [
            'title',
            'Title',
            'track',
            'Track',
            'track_name',
            'Track Name',
            'trackName',
            'name',
            'Name',
            'song',
            'Song'
          ])

          const artist = getField(s, [
            'artist',
            'Artist',
            'artists',
            'Artists',
            'artist_name',
            'Artist Name',
            'singer',
            'Singer',
            'performer',
            'Performer'
          ])

          const album = getField(s, [
            'album',
            'Album',
            'album_name',
            'Album Name',
            'albumName',
            'record',
            'Record',
            'release',
            'Release'
          ])

          const year = getYear(s)
          const genre = getGenre(s)

          if (!title || !artist) {
            console.log('Skipping row (no title/artist):', s)
            failures.push('Row with no title/artist')
            progress.done++
            continue
          }

          const query = `${title} ${artist}`
          console.log('Searching:', query)

          const results = await yts(query)
          const video = results.videos[0]
          if (!video) {
            console.log('No video found for:', query)
            failures.push(`${query} — no YouTube match`)
            progress.done++
            continue
          }

          // filename ONLY from title, with spaces (no underscores)
          const fileBase = makeFileBaseFromTitle(title)

          // Download to a predictable ASCII name so we always know where the
          // file landed (yt-dlp sanitizes its own output names), then rename to
          // the pretty title once it's tagged.
          const workBase = `track_${trackNumber}`
          const outputTemplate = `${tempFolder}/${workBase}.%(ext)s`
          const mp3Path = `${tempFolder}/${workBase}.mp3`

          // 1) download pure audio
          await downloadMP3(video.url, outputTemplate, userQuality)

          if (!fs.existsSync(mp3Path)) {
            console.log('yt-dlp produced no MP3 for:', query)
            failures.push(`${query} — no MP3 produced`)
            progress.done++
            continue
          }

          // 2) fetch nice square album art (movie/album style)
          const coverPath = await fetchAlbumArt(
            title,
            artist,
            tempFolder,
            workBase
          )

          // 3) apply metadata from CSV + embed cover
          try {
            await applyMetadataAndCover(mp3Path, coverPath, {
              title,
              artist,
              album,
              year,
              genre
            })
          } catch (tagErr) {
            console.log(
              'Tagging / cover error (keeping audio anyway):',
              tagErr
            )
          }

          const finalPath = await renameToUniqueTitle(
            mp3Path,
            tempFolder,
            fileBase
          )
          console.log('Tagged & Downloaded:', finalPath)
        } catch (err) {
          console.log('Error downloading:', err.stderr || err.message || err)
          failures.push(describeRowFailure(s, err))
        } finally {
          progress.done++
        }
      }

      // when we're done, reset progress after a little while (optional)
      setTimeout(() => {
        progress.total = 0
        progress.done = 0
      }, 60_000)

      const cleanup = async () => {
        await fs.promises.rm(tempFolder, { recursive: true, force: true })
        await fs.promises.rm(csvPath, { force: true })
      }

      const mp3s = fs
        .readdirSync(tempFolder)
        .filter((f) => f.toLowerCase().endsWith('.mp3'))

      // Nothing downloaded: tell the browser why instead of shipping an empty ZIP
      if (!mp3s.length) {
        console.log('No MP3s were downloaded, sending error instead of ZIP')
        res.status(502).json({
          error: songs.length
            ? 'No songs could be downloaded.'
            : 'The CSV had no rows.',
          failures: failures.slice(0, 20)
        })
        await cleanup()
        return
      }

      console.log(
        `Zipping ${mp3s.length} of ${songs.length} tracks` +
          (failures.length ? ` (${failures.length} failed)` : '')
      )

      // Create ZIP to send to user
      res.setHeader('Content-Type', 'application/zip')
      res.setHeader('Content-Disposition', 'attachment; filename=songs.zip')
      res.setHeader('X-Zipify-Downloaded', String(mp3s.length))
      res.setHeader('X-Zipify-Failed', String(failures.length))

      const zip = archiver('zip')
      zip.on('error', (err) => console.log('ZIP error:', err))
      zip.pipe(res)

      // add the MP3s by name so a leftover cover JPG can't sneak into the ZIP
      for (const name of mp3s) {
        zip.file(path.join(tempFolder, name), { name })
      }

      // only remove the temp files once the ZIP has actually been streamed out
      res.on('close', () => {
        cleanup().catch(() => {})
      })

      zip.finalize()
    })
})

const port = process.env.PORT || 3000
app.listen(port, () => console.log(`Server running at http://localhost:${port}`))
