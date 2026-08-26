import dotenv from 'dotenv';
dotenv.config();

export const mediasoupConfig = {
    worker: {
        rtcMinPort: parseInt(process.env.RTC_MIN_PORT || 40000),
        rtcMaxPort: parseInt(process.env.RTC_MAX_PORT || 49999),
        logLevel: 'warn',
        logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
    },
    router: {
        mediaCodecs: [
            {
                kind: 'audio',
                mimeType: 'audio/opus',
                clockRate: 48000,
                channels: 2
            },
            {
                kind: 'video',
                mimeType: 'video/VP8',
                clockRate: 90000,
                parameters: {
                    'x-google-start-bitrate': 1000
                }
            },
            {
                kind: 'video',
                mimeType: 'video/h264',
                clockRate: 90000,
                parameters: {
                    'packetization-mode': 1,
                    'profile-level-id': '42e01f',
                    'level-asymmetry-allowed': 1
                }
            }
        ]
    },
    webRtcTransport: {
        listenIps: [
            {
                ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
                announcedIp: process.env.MEDIASOUP_ANNOUNCED_ADDRESS || '127.0.0.1'
            }
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
    }
};
