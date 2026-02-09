/**
 * Mediasoup Media Server Configuration
 * Handles WebRTC media routing and recording
 */

const mediasoup = require('mediasoup');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Ensure recordings directory exists
const RECORDINGS_DIR = path.join(__dirname, 'recordings');
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

// Mediasoup configuration
const config = {
  // Worker settings
  worker: {
    rtcMinPort: 10000,
    rtcMaxPort: 10100,
    logLevel: 'warn',
    logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
  },
  // Router settings (media codecs)
  router: {
    mediaCodecs: [
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2,
      },
      {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: {
          'x-google-start-bitrate': 1000,
        },
      },
      {
        kind: 'video',
        mimeType: 'video/H264',
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': '42e01f',
          'level-asymmetry-allowed': 1,
        },
      },
    ],
  },
  // WebRTC transport settings
  webRtcTransport: {
    listenIps: [
      {
        ip: '0.0.0.0',
        announcedIp: null, // Will be set dynamically
      },
    ],
    maxIncomingBitrate: 1500000,
    initialAvailableOutgoingBitrate: 1000000,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
  },
  // Plain transport for recording (RTP to FFmpeg)
  plainTransport: {
    listenIp: { ip: '127.0.0.1', announcedIp: null },
    rtcpMux: false,
    comedia: false,
  },
};

class MediaServer {
  constructor() {
    this.workers = [];
    this.nextWorkerIndex = 0;
    this.rooms = new Map(); // roomId -> Room
    this.peers = new Map(); // peerId -> Peer
  }

  /**
   * Initialize Mediasoup workers
   */
  async init() {
    const numWorkers = require('os').cpus().length;
    console.log(`[MediaServer] Creating ${numWorkers} workers...`);

    for (let i = 0; i < numWorkers; i++) {
      const worker = await mediasoup.createWorker({
        logLevel: config.worker.logLevel,
        logTags: config.worker.logTags,
        rtcMinPort: config.worker.rtcMinPort,
        rtcMaxPort: config.worker.rtcMaxPort,
      });

      worker.on('died', () => {
        console.error(`[MediaServer] Worker ${i} died, exiting...`);
        setTimeout(() => process.exit(1), 2000);
      });

      this.workers.push(worker);
      console.log(`  Worker ${i} created (PID: ${worker.pid})`);
    }

    console.log('[MediaServer] Initialized successfully');
  }

  /**
   * Get next worker (round-robin)
   */
  getNextWorker() {
    const worker = this.workers[this.nextWorkerIndex];
    this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;
    return worker;
  }

  /**
   * Create or get a room
   */
  async getOrCreateRoom(roomId, announcedIp) {
    if (this.rooms.has(roomId)) {
      return this.rooms.get(roomId);
    }

    const worker = this.getNextWorker();
    const router = await worker.createRouter({
      mediaCodecs: config.router.mediaCodecs,
    });

    const room = {
      id: roomId,
      router,
      peers: new Map(),
      recording: null,
      createdAt: Date.now(),
    };

    this.rooms.set(roomId, room);
    console.log(`[MediaServer] Room created: ${roomId}`);
    return room;
  }

  /**
   * Create WebRTC transport for a peer
   */
  async createWebRtcTransport(roomId, peerId, announcedIp) {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`Room ${roomId} not found`);

    const transportOptions = {
      ...config.webRtcTransport,
      listenIps: [
        {
          ip: '0.0.0.0',
          announcedIp: announcedIp || this.getLocalIp(),
        },
      ],
    };

    const transport = await room.router.createWebRtcTransport(transportOptions);

    transport.on('dtlsstatechange', (dtlsState) => {
      if (dtlsState === 'closed') {
        transport.close();
      }
    });

    transport.on('close', () => {
      console.log(`[MediaServer] Transport closed for peer ${peerId}`);
    });

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
      transport,
    };
  }

  /**
   * Connect transport (DTLS handshake)
   */
  async connectTransport(roomId, transportId, dtlsParameters) {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`Room ${roomId} not found`);

    // Find transport in all peers
    for (const [peerId, peer] of room.peers) {
      if (peer.sendTransport?.id === transportId) {
        await peer.sendTransport.connect({ dtlsParameters });
        return;
      }
      if (peer.recvTransport?.id === transportId) {
        await peer.recvTransport.connect({ dtlsParameters });
        return;
      }
    }

    throw new Error(`Transport ${transportId} not found`);
  }

  /**
   * Create a producer (send media to server)
   * AUTO-RECORDING: Starts recording automatically when call is established
   */
  async produce(roomId, peerId, transportId, kind, rtpParameters, appData = {}) {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`Room ${roomId} not found`);

    const peer = room.peers.get(peerId);
    if (!peer) throw new Error(`Peer ${peerId} not found`);

    const producer = await peer.sendTransport.produce({
      kind,
      rtpParameters,
      appData: { ...appData, peerId },
    });

    producer.on('transportclose', () => {
      producer.close();
    });

    peer.producers.set(producer.id, producer);
    console.log(`[MediaServer] Producer created: ${kind} from ${peerId}`);

    // AUTO-RECORDING: Start recording when we have 2+ peers with producers
    await this.checkAndStartAutoRecording(roomId);

    return { id: producer.id, producerId: producer.id };
  }

  /**
   * Check if we should auto-start recording
   * Recording starts when 2+ peers have at least one producer each
   */
  async checkAndStartAutoRecording(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    // If already recording, we can't dynamically add new producers to FFmpeg
    // The recording will include all producers that existed when recording started
    if (room.recording) {
      console.log(`  [Recording] Already in progress - new producers will not be added`);
      return;
    }

    // Count peers with at least one producer
    let peersWithProducers = 0;
    for (const [, peer] of room.peers) {
      if (peer.producers.size > 0) {
        peersWithProducers++;
      }
    }

    // Start recording when 2+ peers are producing (call is established)
    if (peersWithProducers >= 2) {
      console.log(`[Recording] Call established in room ${roomId} - auto-starting recording`);
      await this.startRecording(roomId);
    }
  }

  /**
   * Create a consumer (receive media from server)
   * IMPORTANT: Prevents users from consuming their own media (no echo)
   */
  async consume(roomId, peerId, producerId) {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`Room ${roomId} not found`);

    const peer = room.peers.get(peerId);
    if (!peer) throw new Error(`Peer ${peerId} not found`);

    // Find the producer and its owner
    let producer = null;
    let producerOwnerId = null;
    for (const [ownerId, p] of room.peers) {
      if (p.producers.has(producerId)) {
        producer = p.producers.get(producerId);
        producerOwnerId = ownerId;
        break;
      }
    }

    if (!producer) throw new Error(`Producer ${producerId} not found`);

    // PREVENT ECHO: Don't let a user consume their own producer
    if (producerOwnerId === peerId) {
      console.log(`[MediaServer] Preventing ${peerId} from consuming own ${producer.kind}`);
      throw new Error('Cannot consume own producer');
    }

    // Check if router can consume
    if (!room.router.canConsume({ producerId, rtpCapabilities: peer.rtpCapabilities })) {
      throw new Error('Cannot consume this producer');
    }

    const consumer = await peer.recvTransport.consume({
      producerId,
      rtpCapabilities: peer.rtpCapabilities,
      paused: true, // Start paused, resume after client is ready
    });

    consumer.on('transportclose', () => {
      consumer.close();
    });

    consumer.on('producerclose', () => {
      consumer.close();
      // Notify client that producer closed
    });

    peer.consumers.set(consumer.id, consumer);

    return {
      id: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      appData: producer.appData,
    };
  }

  /**
   * Resume consumer
   */
  async resumeConsumer(roomId, peerId, consumerId) {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`Room ${roomId} not found`);

    const peer = room.peers.get(peerId);
    if (!peer) throw new Error(`Peer ${peerId} not found`);

    const consumer = peer.consumers.get(consumerId);
    if (!consumer) throw new Error(`Consumer ${consumerId} not found`);

    await consumer.resume();
  }

  /**
   * Start recording a room
   * Creates a single combined recording file (MP3 for audio, MP4 for video)
   */
  async startRecording(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`Room ${roomId} not found`);

    if (room.recording) {
      console.log(`[Recording] Already in progress for room ${roomId}`);
      return room.recording;
    }

    const timestamp = Date.now();
    const recordingId = `${roomId}_${timestamp}`;
    
    // Determine if this is a video call (any peer has video producer)
    let hasVideo = false;
    for (const [, peer] of room.peers) {
      for (const [, producer] of peer.producers) {
        if (producer.kind === 'video') {
          hasVideo = true;
          break;
        }
      }
      if (hasVideo) break;
    }

    const outputFile = path.join(RECORDINGS_DIR, `${recordingId}.${hasVideo ? 'mp4' : 'mp3'}`);

    room.recording = {
      id: recordingId,
      startTime: timestamp,
      outputFile,
      hasVideo,
      ffmpegProcess: null,
      transports: [],
      consumers: [],
      audioInputs: [],  // Array of { port, sdpFile }
      videoInputs: [],  // Array of { port, sdpFile }
    };

    // Collect all producers and create recording consumers
    for (const [peerId, peer] of room.peers) {
      for (const [producerId, producer] of peer.producers) {
        await this.createRecordingInput(room, producer, peerId);
      }
    }

    // Now start the single FFmpeg process with all inputs
    await this.startCombinedRecording(room);

    console.log(`[Recording] Started for room ${roomId} -> ${outputFile}`);
    return room.recording;
  }

  /**
   * Create a recording input for a producer (just sets up transport/consumer)
   */
  async createRecordingInput(room, producer, peerId) {
    try {
      // Pick a random port for FFmpeg to receive RTP
      const rtpPort = 20000 + Math.floor(Math.random() * 9000);
      
      // Create plain transport for RTP
      const transport = await room.router.createPlainTransport({
        listenIp: { ip: '127.0.0.1', announcedIp: null },
        rtcpMux: true,
        comedia: false,
      });

      // Connect transport to send RTP to our port
      await transport.connect({
        ip: '127.0.0.1',
        port: rtpPort,
      });

      // Create consumer on the plain transport
      const consumer = await transport.consume({
        producerId: producer.id,
        rtpCapabilities: room.router.rtpCapabilities,
        paused: true, // Will resume after FFmpeg starts
      });

      // Generate SDP for this input
      const sdpContent = this.generateRecordingSdp(consumer, rtpPort, producer.kind);
      const sdpFile = path.join(RECORDINGS_DIR, `${room.recording.id}_${producer.kind}_${peerId}.sdp`);
      fs.writeFileSync(sdpFile, sdpContent);

      // Store for later
      room.recording.transports.push(transport);
      room.recording.consumers.push({ consumer, producerId: producer.id, kind: producer.kind });
      
      if (producer.kind === 'audio') {
        room.recording.audioInputs.push({ port: rtpPort, sdpFile, peerId });
      } else {
        room.recording.videoInputs.push({ port: rtpPort, sdpFile, peerId });
      }

      console.log(`  [Recording] Input: ${producer.kind} from ${peerId} on port ${rtpPort}`);

    } catch (error) {
      console.error(`  [Recording] Failed to create recording input:`, error.message);
    }
  }

  /**
   * Start a single FFmpeg process that combines all inputs
   */
  async startCombinedRecording(room) {
    const recording = room.recording;
    const audioInputs = recording.audioInputs;
    const videoInputs = recording.videoInputs;

    if (audioInputs.length === 0) {
      console.log(`  [Recording] No audio inputs available`);
      return;
    }

    // Build FFmpeg command
    let ffmpegArgs = ['-y'];

    // Add protocol whitelist
    ffmpegArgs.push('-protocol_whitelist', 'file,udp,rtp');
    ffmpegArgs.push('-analyzeduration', '10000000');
    ffmpegArgs.push('-probesize', '10000000');
    ffmpegArgs.push('-fflags', '+genpts+discardcorrupt');

    // Add all audio inputs
    for (const input of audioInputs) {
      ffmpegArgs.push('-i', input.sdpFile);
    }

    // Add all video inputs (if video call)
    if (recording.hasVideo) {
      for (const input of videoInputs) {
        ffmpegArgs.push('-i', input.sdpFile);
      }
    }

    // Build filter complex for mixing
    const totalAudioInputs = audioInputs.length;
    const totalVideoInputs = videoInputs.length;

    if (recording.hasVideo && totalVideoInputs > 0) {
      // VIDEO CALL: Create MP4 with mixed audio and stacked/side-by-side video
      
      // Audio mixing filter
      let filterComplex = '';
      if (totalAudioInputs > 1) {
        // Mix all audio streams
        const audioStreams = audioInputs.map((_, i) => `[${i}:a]`).join('');
        filterComplex += `${audioStreams}amix=inputs=${totalAudioInputs}:duration=longest[aout];`;
      } else {
        filterComplex += `[0:a]acopy[aout];`;
      }

      // Video layout - stack videos vertically if 2, or use first one
      if (totalVideoInputs >= 2) {
        const v1Idx = totalAudioInputs;
        const v2Idx = totalAudioInputs + 1;
        filterComplex += `[${v1Idx}:v][${v2Idx}:v]hstack=inputs=2[vout]`;
      } else if (totalVideoInputs === 1) {
        filterComplex += `[${totalAudioInputs}:v]copy[vout]`;
      }

      ffmpegArgs.push('-filter_complex', filterComplex);
      ffmpegArgs.push('-map', '[aout]', '-map', '[vout]');
      ffmpegArgs.push('-c:a', 'aac', '-b:a', '192k');
      ffmpegArgs.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '23');
      ffmpegArgs.push(recording.outputFile);

    } else {
      // AUDIO ONLY: Create MP3 with mixed audio
      
      if (totalAudioInputs > 1) {
        // Mix all audio streams
        const audioStreams = audioInputs.map((_, i) => `[${i}:a]`).join('');
        ffmpegArgs.push('-filter_complex', `${audioStreams}amix=inputs=${totalAudioInputs}:duration=longest[aout]`);
        ffmpegArgs.push('-map', '[aout]');
      }

      ffmpegArgs.push('-c:a', 'libmp3lame', '-b:a', '192k');
      ffmpegArgs.push(recording.outputFile);
    }

    console.log(`  [FFmpeg] Starting: ffmpeg ${ffmpegArgs.slice(0, 20).join(' ')}...`);

    const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    ffmpeg.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('Error') || msg.includes('error') || msg.includes('Invalid') || msg.includes('failed')) {
        console.log(`  [FFmpeg] Error: ${msg.trim()}`);
      } else if (msg.includes('time=') || msg.includes('size=')) {
        if (!this._lastFFmpegLog || Date.now() - this._lastFFmpegLog > 5000) {
          // Extract just the time info
          const timeMatch = msg.match(/time=(\d+:\d+:\d+\.\d+)/);
          const sizeMatch = msg.match(/size=\s*(\d+\w+)/);
          if (timeMatch || sizeMatch) {
            console.log(`  [Recording] ${timeMatch ? 'time=' + timeMatch[1] : ''} ${sizeMatch ? 'size=' + sizeMatch[1] : ''}`);
          }
          this._lastFFmpegLog = Date.now();
        }
      }
    });

    ffmpeg.on('error', (err) => {
      console.log(`  [FFmpeg] Spawn error: ${err.message}`);
    });

    ffmpeg.on('close', (code, signal) => {
      if (code === 0) {
        console.log(`  [Recording] Saved: ${recording.outputFile}`);
      } else if (signal) {
        console.log(`  [FFmpeg] Stopped (signal: ${signal})`);
      } else {
        console.log(`  [FFmpeg] Exited (code: ${code})`);
      }
    });

    recording.ffmpegProcess = ffmpeg;

    // Wait for FFmpeg to start listening
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Resume all consumers to start RTP flow
    for (const { consumer, kind } of recording.consumers) {
      await consumer.resume();
      console.log(`  [Recording] Stream resumed: ${kind}`);
    }
  }

  /**
   * Add a new producer to ongoing recording
   */
  async addProducerToRecording(room, producer, peerId) {
    if (!room.recording) return;
    
    // For now, we can't dynamically add inputs to an active FFmpeg process
    // So we'll just log this - in a production system you'd need a more complex approach
    console.log(`  [Recording] New producer during recording - not added to current recording`);
  }

  /**
   * Generate SDP for FFmpeg input (recording)
   */
  generateRecordingSdp(consumer, rtpPort, kind) {
    const { rtpParameters } = consumer;
    const codec = rtpParameters.codecs[0];
    const payloadType = codec.payloadType;

    let sdp = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=MediasoupRecording
c=IN IP4 127.0.0.1
t=0 0
`;

    if (kind === 'audio') {
      const channels = codec.channels || 2;
      sdp += `m=audio ${rtpPort} RTP/AVP ${payloadType}
a=rtpmap:${payloadType} opus/${codec.clockRate}/${channels}
a=fmtp:${payloadType} minptime=10;useinbandfec=1
a=recvonly
`;
    } else {
      sdp += `m=video ${rtpPort} RTP/AVP ${payloadType}
a=rtpmap:${payloadType} VP8/${codec.clockRate}
a=recvonly
`;
    }

    return sdp;
  }

  /**
   * Stop recording a room
   */
  async stopRecording(roomId) {
    const room = this.rooms.get(roomId);
    if (!room || !room.recording) {
      console.log(`[Recording] No active recording for room ${roomId}`);
      return null;
    }

    const recording = room.recording;

    // Stop FFmpeg gracefully
    if (recording.ffmpegProcess) {
      try {
        recording.ffmpegProcess.stdin.write('q'); // Graceful quit
        
        // Give it time to finish writing
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // If still running, send SIGTERM
        try { recording.ffmpegProcess.kill('SIGTERM'); } catch (e) {}
        
        // Last resort after another 2 seconds
        setTimeout(() => {
          try { recording.ffmpegProcess.kill('SIGKILL'); } catch (e) {}
        }, 2000);
      } catch (e) {
        // Process may already be dead
      }
    }

    // Close all recording consumers and transports
    for (const item of recording.consumers) {
      try {
        const consumer = item.consumer || item;
        consumer.close();
      } catch (e) {}
    }
    for (const transport of recording.transports) {
      try {
        transport.close();
      } catch (e) {}
    }

    // Clean up SDP files
    for (const input of [...(recording.audioInputs || []), ...(recording.videoInputs || [])]) {
      try {
        if (input.sdpFile && fs.existsSync(input.sdpFile)) {
          fs.unlinkSync(input.sdpFile);
        }
      } catch (e) {}
    }

    const duration = Date.now() - recording.startTime;
    console.log(`[Recording] Stopped: ${recording.outputFile} (duration: ${Math.round(duration / 1000)}s)`);

    room.recording = null;

    return {
      id: recording.id,
      duration,
      file: recording.outputFile,
    };
  }

  /**
   * Add peer to room
   */
  async addPeer(roomId, peerId, username, announcedIp) {
    const room = await this.getOrCreateRoom(roomId, announcedIp);

    const peer = {
      id: peerId,
      username,
      sendTransport: null,
      recvTransport: null,
      producers: new Map(),
      consumers: new Map(),
      rtpCapabilities: null,
    };

    room.peers.set(peerId, peer);
    this.peers.set(peerId, { roomId, peer });

    console.log(`[MediaServer] Peer ${username} joined room ${roomId}`);

    return {
      routerRtpCapabilities: room.router.rtpCapabilities,
    };
  }

  /**
   * Set peer's RTP capabilities
   */
  setPeerRtpCapabilities(roomId, peerId, rtpCapabilities) {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`Room ${roomId} not found`);

    const peer = room.peers.get(peerId);
    if (!peer) throw new Error(`Peer ${peerId} not found`);

    peer.rtpCapabilities = rtpCapabilities;
  }

  /**
   * Store transport for peer
   */
  storePeerTransport(roomId, peerId, transport, direction) {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`Room ${roomId} not found`);

    const peer = room.peers.get(peerId);
    if (!peer) throw new Error(`Peer ${peerId} not found`);

    if (direction === 'send') {
      peer.sendTransport = transport;
    } else {
      peer.recvTransport = transport;
    }
  }

  /**
   * Remove peer from room
   * AUTO-RECORDING: Stops recording when call ends (less than 2 peers with producers)
   */
  removePeer(peerId) {
    const peerInfo = this.peers.get(peerId);
    if (!peerInfo) return;

    const { roomId, peer } = peerInfo;
    const room = this.rooms.get(roomId);

    if (room) {
      // Close all producers
      for (const [, producer] of peer.producers) {
        producer.close();
      }

      // Close all consumers
      for (const [, consumer] of peer.consumers) {
        consumer.close();
      }

      // Close transports
      if (peer.sendTransport) peer.sendTransport.close();
      if (peer.recvTransport) peer.recvTransport.close();

      room.peers.delete(peerId);
      console.log(`[MediaServer] Peer ${peer.username} left room ${roomId}`);

      // AUTO-RECORDING: Stop recording if less than 2 peers remain (call ended)
      if (room.recording && room.peers.size < 2) {
        console.log(`[Recording] Call ended in room ${roomId} - auto-stopping recording`);
        this.stopRecording(roomId);
      }

      // Clean up empty room
      if (room.peers.size === 0) {
        room.router.close();
        this.rooms.delete(roomId);
        console.log(`[MediaServer] Room ${roomId} closed (empty)`);
      }
    }

    this.peers.delete(peerId);
  }

  /**
   * Get all producers in a room (except from the requesting peer)
   */
  getProducers(roomId, excludePeerId) {
    const room = this.rooms.get(roomId);
    if (!room) return [];

    const producers = [];
    for (const [peerId, peer] of room.peers) {
      if (peerId === excludePeerId) continue;
      for (const [producerId, producer] of peer.producers) {
        producers.push({
          producerId,
          peerId,
          username: peer.username,
          kind: producer.kind,
        });
      }
    }

    return producers;
  }

  /**
   * Get local IP address
   */
  getLocalIp() {
    const os = require('os');
    const interfaces = os.networkInterfaces();

    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }

    return '127.0.0.1';
  }

  /**
   * Get room stats
   */
  getRoomStats(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    return {
      id: roomId,
      peerCount: room.peers.size,
      isRecording: !!room.recording,
      createdAt: room.createdAt,
      peers: Array.from(room.peers.values()).map(p => ({
        id: p.id,
        username: p.username,
        producerCount: p.producers.size,
        consumerCount: p.consumers.size,
      })),
    };
  }
}

module.exports = { MediaServer, config };
