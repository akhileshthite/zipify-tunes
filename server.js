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

// In-memory jobs (single-user / local use). The upload request returns a job
// id straight away; the page polls it and, once the tracks are ready, the
// browser fetches /download/<id> as a normal file download.
const jobs = new Map()

// a finished job that is never downloaded shouldn't hold its MP3s forever
const JOB_TTL_MS = 30 * 60 * 1000

// leftovers from a crashed or killed run
for (const entry of fs.readdirSync('.')) {
  if (/^mp3s_\d+$/.test(entry)) {
    fs.rmSync(entry, { recursive: true, force: true })
  }
}

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

function formatBytes (bytes) {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + ' GB'
  return Math.round(bytes / 1024 ** 2) + ' MB'
}

async function freeSpace (dir) {
  const { bavail, bsize } = await fs.promises.statfs(dir)
  return bavail * bsize
}

// rough guess used before anything is downloaded: MP3s land around 5-10 MB
const ESTIMATED_BYTES_PER_TRACK = 10 * 1024 * 1024

// A run needs two copies of the audio on the same disk: the temp MP3s and the
// ZIP the browser saves. (The browser streams the ZIP straight to disk, so it
// doesn't need a third, buffered copy.)
const PEAK_COPIES = 2

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

// what the page sees when it polls a job
function publicJob (job) {
  return {
    id: job.id,
    status: job.status, // running | ready | error
    total: job.total,
    done: job.done,
    downloaded: job.mp3s.length,
    zipBytes: job.zipBytes,
    failures: job.failures.slice(0, 20),
    error: job.error
  }
}

async function removeJob (job) {
  jobs.delete(job.id)
  clearTimeout(job.expiry)
  await fs.promises.rm(job.tempFolder, { recursive: true, force: true })
}

function failJob (job, message) {
  console.log(message)
  job.status = 'error'
  job.error = message
  removeJob(job).catch(() => {})
}

// Poll a job's progress
app.get('/progress', (req, res) => {
  const job = jobs.get(req.query.job)
  if (!job) return res.status(404).json({ error: 'Unknown job' })
  res.json(publicJob(job))
})

// Start a job: parse the CSV, kick off the downloads, return the job id
app.post('/upload', upload.single('csv'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No CSV file was uploaded.' })
  }

  const csvPath = req.file.path
  const songs = []
  const userQuality = req.body.quality || '0'

  fs.createReadStream(csvPath)
    .pipe(csv())
    .on('data', (row) => songs.push(row))
    .on('error', (err) => {
      fs.promises.rm(csvPath, { force: true }).catch(() => {})
      res.status(400).json({ error: 'Could not parse CSV: ' + err.message })
    })
    .on('end', () => {
      // the CSV is fully in memory now
      fs.promises.rm(csvPath, { force: true }).catch(() => {})

      if (!songs.length) {
        return res.status(400).json({ error: 'The CSV had no rows.' })
      }

      const job = {
        id: String(Date.now()),
        status: 'running',
        total: songs.length,
        done: 0,
        mp3s: [],
        zipBytes: 0,
        failures: [],
        error: null,
        tempFolder: 'mp3s_' + Date.now(),
        expiry: null
      }
      jobs.set(job.id, job)
      fs.mkdirSync(job.tempFolder)

      res.json({ jobId: job.id })

      runJob(job, songs, userQuality).catch((err) => {
        failJob(job, 'Unexpected error: ' + (err.message || err))
      })
    })
})

async function runJob (job, songs, userQuality) {
  const { tempFolder, failures } = job

  // wait for the yt-dlp update check before touching the binary
  await ytDlpReady

  // Bail out now rather than downloading for minutes and handing back a ZIP
  // the browser has no room to save.
  const needed = songs.length * ESTIMATED_BYTES_PER_TRACK * PEAK_COPIES
  const freeBefore = await freeSpace('.')

  if (freeBefore < needed) {
    failJob(
      job,
      `Not enough disk space. ${songs.length} tracks need about ` +
        `${formatBytes(needed)} free, but only ${formatBytes(freeBefore)} ` +
        'is available. Free up space, pick a lower quality, or split the ' +
        'CSV into smaller batches.'
    )
    return
  }

  let trackNumber = 0

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
        job.done++
        continue
      }

      const query = `${title} ${artist}`
      console.log('Searching:', query)

      const results = await yts(query)
      const video = results.videos[0]
      if (!video) {
        console.log('No video found for:', query)
        failures.push(`${query} — no YouTube match`)
        job.done++
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
        job.done++
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
      job.done++
    }
  }

  const mp3s = fs
    .readdirSync(tempFolder)
    .filter((f) => f.toLowerCase().endsWith('.mp3'))

  if (!mp3s.length) {
    failJob(job, 'No songs could be downloaded.')
    return
  }

  // Re-check with the real sizes now that the MP3s exist: the ZIP the browser
  // saves is about the size of the audio inside it.
  const zipBytes = mp3s.reduce(
    (sum, name) => sum + fs.statSync(path.join(tempFolder, name)).size,
    0
  )
  const neededNow = zipBytes * (PEAK_COPIES - 1)
  const freeNow = await freeSpace('.')

  if (freeNow < neededNow) {
    failJob(
      job,
      `Downloaded ${mp3s.length} tracks (${formatBytes(zipBytes)}), but ` +
        `saving the ZIP needs ${formatBytes(neededNow)} free and only ` +
        `${formatBytes(freeNow)} is available. Free up some disk space and ` +
        'try again.'
    )
    return
  }

  job.mp3s = mp3s
  job.zipBytes = zipBytes
  job.status = 'ready'
  job.expiry = setTimeout(() => {
    console.log(`Job ${job.id} was never downloaded, cleaning up`)
    removeJob(job).catch(() => {})
  }, JOB_TTL_MS)

  console.log(
    `Ready: ${mp3s.length} of ${songs.length} tracks, ${formatBytes(zipBytes)}` +
      (failures.length ? ` (${failures.length} failed)` : '')
  )
}

// Stream the ZIP as a normal browser download. Nothing is buffered on either
// side: archiver reads the MP3s and the browser writes straight to disk.
app.get('/download/:id', (req, res) => {
  const job = jobs.get(req.params.id)

  if (!job || job.status !== 'ready') {
    return res
      .status(404)
      .send('This download is no longer available. Run the CSV again.')
  }

  // a second click while the first download is running would fight over the
  // same files, so hand the job to this response only
  jobs.delete(job.id)
  clearTimeout(job.expiry)

  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', 'attachment; filename="songs.zip"')

  // store, don't deflate: MP3s are already compressed, so deflating 100s of MB
  // of audio burns CPU for about nothing
  const zip = archiver('zip', { store: true })
  zip.on('error', (err) => console.log('ZIP error:', err))
  zip.pipe(res)

  // add the MP3s by name so a leftover cover JPG can't sneak into the ZIP
  for (const name of job.mp3s) {
    zip.file(path.join(job.tempFolder, name), { name })
  }

  // only remove the temp files once the ZIP has actually been streamed out
  res.on('close', () => {
    if (res.writableFinished) {
      console.log(`ZIP sent (${formatBytes(job.zipBytes)})`)
    } else {
      console.log('Browser disconnected before the ZIP finished')
    }
    fs.promises
      .rm(job.tempFolder, { recursive: true, force: true })
      .catch(() => {})
  })

  zip.finalize()
})

const port = process.env.PORT || 3000
app.listen(port, () => console.log(`Server running at http://localhost:${port}`))
