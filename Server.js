// server.js - Final Production Version
const express = require('express');
const cors = require('cors');
const ytdl = require('ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
    origin: process.env.NODE_ENV === 'production' 
        ? ['https://your-app-name.onrender.com'] 
        : ['http://localhost:3000', 'http://localhost:8000', 'http://127.0.0.1:8000']
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// Create temp directory for processing
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}

// Serve frontend on root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Clean up temp files older than 30 minutes
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
                
                // Delete files older than 30 minutes (1800000 ms)
                if (fileAge > 1800000) {
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

// Run cleanup every 10 minutes
setInterval(cleanupTempFiles, 600000);

// Endpoint to get video information
app.get('/api/video-info/:videoId', async (req, res) => {
    try {
        const { videoId } = req.params;
        
        if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
            return res.status(400).json({ error: 'Invalid video ID' });
        }
        
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        
        // Add timeout for ytdl.getInfo
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Request timeout')), 10000);
        });
        
        const infoPromise = ytdl.getInfo(videoUrl);
        const info = await Promise.race([infoPromise, timeoutPromise]);
        
        const videoDetails = info.videoDetails;
        
        res.json({
            title: videoDetails.title || 'Unknown Title',
            duration: formatDuration(videoDetails.lengthSeconds || 0),
            view_count: formatNumber(videoDetails.viewCount || 0),
            author: videoDetails.author?.name || 'Unknown Author',
            description: (videoDetails.shortDescription || '').substring(0, 200) + '...',
        });
    } catch (error) {
        console.error('Error fetching video info:', error);
        res.status(500).json({ 
            error: 'Failed to fetch video information',
            message: error.message
        });
    }
});

// Main endpoint to process audio
app.post('/api/process-audio', async (req, res) => {
    const { videoId, pitchShift = 0, playbackSpeed = 1 } = req.body;
    
    // Validation
    if (!videoId) {
        return res.status(400).json({ error: 'Video ID is required' });
    }
    
    if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
        return res.status(400).json({ error: 'Invalid video ID format' });
    }
    
    if (pitchShift < -12 || pitchShift > 12) {
        return res.status(400).json({ error: 'Pitch shift must be between -12 and 12 semitones' });
    }
    
    if (playbackSpeed < 0.25 || playbackSpeed > 2.0) {
        return res.status(400).json({ error: 'Playback speed must be between 0.25 and 2.0' });
    }

    const sessionId = uuidv4();
    const inputFile = path.join(tempDir, `${sessionId}_input.webm`);
    const outputFile = path.join(tempDir, `${sessionId}_output.mp3`);
    
    console.log(`Processing audio for video: ${videoId}, pitch: ${pitchShift}, speed: ${playbackSpeed}`);

    try {
        // Step 1: Download audio from YouTube
        await downloadYouTubeAudio(videoId, inputFile);
        
        // Step 2: Process audio with FFmpeg
        await processAudioWithFFmpeg(inputFile, outputFile, pitchShift, playbackSpeed);
        
        // Step 3: Stream the processed audio back to client
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Disposition', 'attachment; filename="processed_audio.mp3"');
        res.setHeader('Cache-Control', 'no-cache');
        
        const audioStream = fs.createReadStream(outputFile);
        audioStream.pipe(res);
        
        // Clean up files after streaming
        audioStream.on('end', () => {
            setTimeout(() => {
                [inputFile, outputFile].forEach(file => {
                    if (fs.existsSync(file)) {
                        fs.unlink(file, (err) => {
                            if (err) console.error('Error deleting file:', err);
                        });
                    }
                });
            }, 5000); // Wait 5 seconds before cleanup
        });
        
        audioStream.on('error', (error) => {
            console.error('Stream error:', error);
            res.status(500).json({ error: 'Failed to stream audio' });
        });
        
    } catch (error) {
        console.error('Error processing audio:', error);
        
        // Clean up files on error
        [inputFile, outputFile].forEach(file => {
            if (fs.existsSync(file)) {
                fs.unlink(file, (err) => {
                    if (err) console.error('Error deleting file:', err);
                });
            }
        });
        
        if (error.message.includes('Video unavailable')) {
            res.status(404).json({ error: 'Video not available or restricted' });
        } else if (error.message.includes('timeout')) {
            res.status(408).json({ error: 'Request timeout - video may be too long' });
        } else {
            res.status(500).json({ error: 'Failed to process audio: ' + error.message });
        }
    }
});

// Function to download audio from YouTube
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
            
            // Add timeout
            const timeout = setTimeout(() => {
                audioStream.destroy();
                writeStream.destroy();
                reject(new Error('Download timeout'));
            }, 60000); // 60 second timeout
            
            audioStream.pipe(writeStream);
            
            audioStream.on('error', (error) => {
                clearTimeout(timeout);
                console.error('YouTube download error:', error);
                reject(new Error('Failed to download audio from YouTube: ' + error.message));
            });
            
            writeStream.on('finish', () => {
                clearTimeout(timeout);
                console.log('Audio download completed');
                resolve();
            });
            
            writeStream.on('error', (error) => {
                clearTimeout(timeout);
                console.error('File write error:', error);
                reject(new Error('Failed to save downloaded audio'));
            });
            
        } catch (error) {
            reject(new Error('Failed to initialize download: ' + error.message));
        }
    });
}

// Function to process audio with FFmpeg
function processAudioWithFFmpeg(inputPath, outputPath, pitchShift, playbackSpeed) {
    return new Promise((resolve, reject) => {
        try {
            let command = ffmpeg(inputPath)
                .audioBitrate(128)
                .audioCodec('mp3')
                .format('mp3');
            
            // Build audio filters
            const audioFilters = [];
            
            // Apply pitch shift if needed
            if (pitchShift !== 0) {
                // Convert semitones to pitch ratio
                const pitchRatio = Math.pow(2, pitchShift / 12);
                // Use rubberband for better quality pitch shifting
                audioFilters.push(`asetrate=44100*${pitchRatio},aresample=44100`);
            }
            
            // Apply tempo change if needed (atempo has limits, chain if needed)
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
            
            // Apply filters if any exist
            if (audioFilters.length > 0) {
                command = command.audioFilters(audioFilters);
            }
            
            command
                .output(outputPath)
                .on('start', (commandLine) => {
                    console.log('FFmpeg command:', commandLine);
                })
                .on('progress', (progress) => {
                    if (progress.percent) {
                        console.log('Processing progress:', Math.round(progress.percent) + '%');
                    }
                })
                .on('end', () => {
                    console.log('Audio processing completed');
                    resolve();
                })
                .on('error', (error) => {
                    console.error('FFmpeg error:', error);
                    reject(new Error('Audio processing failed: ' + error.message));
                });
                
            // Add timeout for FFmpeg processing
            setTimeout(() => {
                command.kill('SIGKILL');
                reject(new Error('Processing timeout'));
            }, 120000); // 2 minute timeout
                
            command.run();
            
        } catch (error) {
            reject(new Error('Failed to start audio processing: ' + error.message));
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

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        message: 'Pitch Perfect Practice Backend is running',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

// Handle 404s
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({ error: 'Internal server error' });
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Pitch Perfect Practice Backend running on port ${PORT}`);
    console.log(`📋 Health check: http://localhost:${PORT}/api/health`);
    console.log(`🎵 Ready to process YouTube audio!`);
    
    // Run initial cleanup
    cleanupTempFiles();
});

// Graceful shutdown
const gracefulShutdown = () => {
    console.log('🔄 Starting graceful shutdown...');
    
    server.close(() => {
        console.log('✅ HTTP server closed');
        
        // Clean up temp directory
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
        
        console.log('✅ Graceful shutdown completed');
        process.exit(0);
    });
    
    // Force shutdown after 10 seconds
    setTimeout(() => {
        console.log('⚠️  Forcing shutdown');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
