import dotenv from 'dotenv';
dotenv.config();

export function getIceServers() {
    const iceServers = [
        { urls: ["stun:stun.l.google.com:19302"] }
    ];

    if (process.env.TURN_HOST && process.env.TURN_USERNAME) {
        iceServers.push({
            urls: [
                `turn:${process.env.TURN_HOST}:${process.env.TURN_PORT || 3478}?transport=udp`,
                `turn:${process.env.TURN_HOST}:${process.env.TURN_PORT || 3478}?transport=tcp`
            ],
            username: process.env.TURN_USERNAME,
            credential: process.env.TURN_PASSWORD
        });
    }

    return iceServers;
}
