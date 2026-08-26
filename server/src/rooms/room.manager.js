import { getWorker } from '../mediasoup/worker.js';
import { mediasoupConfig } from '../config/mediasoup.config.js';
import { log, logError } from '../utils/logger.js';

const rooms = new Map(); // roomId -> { router, participants }

export async function getOrCreateRoom(roomId) {
    if (rooms.has(roomId)) {
        return rooms.get(roomId);
    }

    log('getOrCreateRoom: criando nova sala', { roomId });
    const worker = getWorker();
    const router = await worker.createRouter({ mediaCodecs: mediasoupConfig.router.mediaCodecs });
    
    const room = {
        id: roomId,
        router,
        participants: new Map() // socketId -> participant info
    };
    
    rooms.set(roomId, room);
    return room;
}

export function removeParticipant(roomId, socketId) {
    log('removeParticipant: iniciado', { roomId, socketId });
    const room = rooms.get(roomId);
    if (!room) return null;

    const participant = room.participants.get(socketId);
    if (!participant) return null;

    // Fechar transports, producers e consumers
    participant.producers.forEach(producer => producer.close());
    participant.consumers.forEach(consumer => consumer.close());
    if (participant.producerTransport) participant.producerTransport.close();
    if (participant.consumerTransport) participant.consumerTransport.close();

    room.participants.delete(socketId);
    log('removeParticipant: recursos liberados', { socketId });

    if (room.participants.size === 0) {
        log('removeParticipant: sala vazia, fechando router', { roomId });
        room.router.close();
        rooms.delete(roomId);
    }

    return room;
}

export function getRoom(roomId) {
    return rooms.get(roomId);
}
