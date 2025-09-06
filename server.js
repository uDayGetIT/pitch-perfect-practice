// server.js - Complete Render Production Version
const express = require('express');
const cors = require('cors');
const ytdl = require('ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3001;

// FFmpeg path configuration for Render
if (process.env.NODE_ENV === 'production') {
    const ffmpegPaths = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/render/project/src/node_modules/ffmpeg-static/ffmpeg'];
    for (const ffmpegPath of ffmpegPaths) {
        if (fs.existsSync(ffmpegPath)) {
            ffmpeg.setFfmpegPath(ffmpegPath);
            console.log(`FFmpeg found at: ${ffmpegPath}`);
            break;
        }
    }
}

// CORS configuration with your Render URL
app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        
        const allowedOrigins = process.env.NODE_ENV === 'production' 
            ? [
                'https://pitch-perfect-practice.onrender.com',
                /^https:\/\/.*\.onrender\.com$/
              ] 
            : [
                'http://localhost:3000', 
                'http://localhost:8000', 
                'http://127.0.0.1:8000',
                'http://localhost:3001'
              ];
        
        const isAllowed = allowedOrigins.some(allowed => {
            if (typeof allowed === 'string') {
                return origin === allowed;
            }
            return allowed.test(origin);
        });
        
        callback(null, true); // Allow all origins for now
    },
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// Create temp directory
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        message: 'Pitch Perfect Practice Backend is running',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        environment: process.env.NODE_ENV || 'development'
    });
});

// Cleanup function
const cleanupTempFiles = () => {
    try {
        if (!fs.existsSync(tempDir)) return;
        
        const files = fs.readdirSync(tempDir);
        const now = Date.now();
        
        files.forEach(file => {
            try {
                const filePath = path.join(tempDir, file);
                const stats = fs.statSync(filePath);
                const fileAge = now - stats.mtime.getTime();
                
                if (fileAge > 900000) { // 15 minutes
                    fs.unlinkSync(filePath);
                    console.log(`Cleaned up old temp file: ${file}`);
                }
            } catch (err) {
                console.error(`Error cleaning up file ${file}:`, err);
            }
        });
    } catch (err) {
        console.error('Error in cleanup process:', err);
    }
};

setInterval(cleanupTempFiles, 300000); // 5 minutes

// Video info endpoint
app.get('/api/video-info/:videoId', async (req, res) => {
    try {
        const { videoId } = req.params;
        
        if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
            return res.status(400).json({ error: 'Invalid video ID format' });
        }
        
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Request timeout')), 15000);
        });
        
        const infoPromise = ytdl.getInfo(videoUrl, {
            requestOptions: {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            }
        });
        
        const info = await Promise.race([infoPromise, timeoutPromise]);
        const videoDetails = info.videoDetails;
        
        const duration = parseInt(videoDetails.lengthSeconds || 0);
        if (duration > 600) {
            return res.status(400).json({ 
                error: 'Video too long. Please use videos under 10 minutes.' 
            });
        }
        
        res.json({
            title: videoDetails.title || 'Unknown Title',
            duration: formatDuration(duration),
            view_count: formatNumber(videoDetails.viewCount || 0),
            author: videoDetails.author?.name || 'Unknown Author',
            description: (videoDetails.shortDescription || '').substring(0, 200) + '...',
            lengthSeconds: duration
        });
        
    } catch (error) {
        console.error('Error fetching video info:', error);
        
        if (error.message.includes('Video unavailable')) {
            res.status(404).json({ error: 'Video not found or is private/restricted' });
        } else if (error.message.includes('timeout')) {
            res.status(408).json({ error: 'Request timeout - please try again' });
        } else {
            res.status(500).json({ 
                error: 'Failed to fetch video information'
            });
        }
    }
});

// Audio processing endpoint
app.post('/api/process-audio', async (req, res) => {
    const { videoId, pitchShift = 0, playbackSpeed = 1 } = req.body;
    
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
        return res.status(400).json({ error: 'Invalid video ID' });
    }
    
    if (pitchShift < -12 || pitchShift > 12) {
        return res.status(400).json({ error: 'Pitch shift must be between -12 and 12' });
    }
    
    if (playbackSpeed < 0.25 || playbackSpeed > 2.0) {
        return res.status(400).json({ error: 'Speed must be between 0.25 and 2.0' });
    }

    const sessionId = uuidv4();
    const inputFile = path.join(tempDir, `${sessionId}_input.webm`);
    const outputFile = path.join(tempDir, `${sessionId}_output.mp3`);
    
    console.log(`Processing: ${videoId}, pitch: ${pitchShift}, speed: ${playbackSpeed}`);

    const requestTimeout = setTimeout(() => {
        if (!res.headersSent) {
            res.status(408).json({ error: 'Processing timeout' });
        }
    }, 25000);

    try {
        await downloadYouTubeAudio(videoId, inputFile);
        await processAudioWithFFmpeg(inputFile, outputFile, pitchShift, playbackSpeed);
        
        clearTimeout(requestTimeout);
        
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Disposition', 'attachment; filename="processed_audio.mp3"');
        res.setHeader('Cache-Control', 'no-cache');
        
        const audioStream = fs.createReadStream(outputFile);
        audioStream.pipe(res);
        
        audioStream.on('end', () => {
            setTimeout(() => {
                [inputFile, outputFile].forEach(file => {
                    if (fs.existsSync(file)) {
                        fs.unlink(file, (err) => {
                            if (err) console.error('Error deleting file:', err);
                        });
                    }
                });
            }, 5000);
        });
        
    } catch (error) {
        clearTimeout(requestTimeout);
        console.error('Error processing audio:', error);
        
        [inputFile, outputFile].forEach(file => {
            if (fs.existsSync(file)) {
                fs.unlink(file, () => {});
            }
        });
        
        if (!res.headersSent) {
            if (error.message.includes('Video unavailable')) {
                res.status(404).json({ error: 'Video not available' });
            } else if (error.message.includes('timeout')) {
                res.status(408).json({ error: 'Processing timeout' });
            } else {
                res.status(500).json({ error: 'Failed to process audio' });
            }
        }
    }
});

// Download audio function
function downloadYouTubeAudio(videoId, outputPath) {
    return new Promise((resolve, reject) => {
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        
        try {
            const audioStream = ytdl(videoUrl, {
                quality: 'highestaudio',
                filter: 'audioonly',
                requestOptions: {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                }
            });

            const writeStream = fs.createWriteStream(outputPath);
            
            const timeout = setTimeout(() => {
                audioStream.destroy();
                writeStream.destroy();
                reject(new Error('Download timeout'));
            }, 30000);
            
            audioStream.pipe(writeStream);
            
            audioStream.on('error', (error) => {
                clearTimeout(timeout);
                reject(new Error('Download failed: ' + error.message));
            });
            
            writeStream.on('finish', () => {
                clearTimeout(timeout);
                resolve();
            });
            
            writeStream.on('error', (error) => {
                clearTimeout(timeout);
                reject(new Error('File write failed'));
            });
            
        } catch (error) {
            reject(new Error('Download init failed: ' + error.message));
        }
    });
}

// Process audio function
function processAudioWithFFmpeg(inputPath, outputPath, pitchShift, playbackSpeed) {
    return new Promise((resolve, reject) => {
        try {
            let command = ffmpeg(inputPath)
                .audioBitrate(128)
                .audioCodec('mp3')
                .format('mp3');
            
            const audioFilters = [];
            
            if (pitchShift !== 0) {
                const pitchRatio = Math.pow(2, pitchShift / 12);
                audioFilters.push(`asetrate=44100*${pitchRatio},aresample=44100`);
            }
            
            if (playbackSpeed !== 1) {
                let speed = playbackSpeed;
                while (speed > 2) {
                    audioFilters.push('atempo=2');
                    speed /= 2;
                }
                while (speed < 0.5) {
                    audioFilters.push('atempo=0.5');
                    speed /= 0.5;
                }
                if (speed !== 1) {
                    audioFilters.push(`atempo=${speed}`);
                }
            }
            
            if (audioFilters.length > 0) {
                command = command.audioFilters(audioFilters);
            }
            
            command
                .output(outputPath)
                .on('end', resolve)
                .on('error', (error) => {
                    reject(new Error('Processing failed: ' + error.message));
                });
                
            setTimeout(() => {
                command.kill('SIGKILL');
                reject(new Error('Processing timeout'));
            }, 60000);
                
            command.run();
            
        } catch (error) {
            reject(new Error('Processing init failed: ' + error.message));
        }
    });
}

// Utility functions
function formatDuration(seconds) {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hrs > 0) {
        return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
}

function formatNumber(num) {
    const n = parseInt(num);
    if (n >= 1000000000) {
        return (n / 1000000000).toFixed(1) + 'B';
    } else if (n >= 1000000) {
        return (n / 1000000).toFixed(1) + 'M';
    } else if (n >= 1000) {
        return (n / 1000).toFixed(1) + 'K';
    }
    return n.toString();
}

// Handle 404s
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Pitch Perfect Practice running on port ${PORT}`);
    console.log(`📋 Health check: http://localhost:${PORT}/api/health`);
    cleanupTempFiles();
});

// Graceful shutdown
const gracefulShutdown = () => {
    console.log('🔄 Starting graceful shutdown...');
    
    server.close(() => {
        console.log('✅ HTTP server closed');
        
        try {
            if (fs.existsSync(tempDir)) {
                const files = fs.readdirSync(tempDir);
                files.forEach(file => {
                    fs.unlinkSync(path.join(tempDir, file));
                });
                console.log('✅ Temp files cleaned up');
            }
        } catch (error) {
            console.error('❌ Error during cleanup:', error);
        }
        
        process.exit(0);
    });
    
    setTimeout(() => {
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
