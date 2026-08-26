import { getOrCreateRoom, getRoom, removeParticipant } from '../rooms/room.manager.js';
import { mediasoupConfig } from '../config/mediasoup.config.js';
import { getIceServers } from '../config/ice.config.js';
import { log, logError } from '../utils/logger.js';

export function setupSocketHandlers(io) {
    io.on('connection', (socket) => {
        log('Socket conectado', { socketId: socket.id });

        let currentRoomId = null;

        socket.on('join-room', async ({ roomId, username }, callback) => {
            log('join-room: iniciado', { socketId: socket.id, roomId, username });
            try {
                currentRoomId = roomId;
                const room = await getOrCreateRoom(roomId);
                
                room.participants.set(socket.id, {
                    socketId: socket.id,
                    username,
                    producerTransport: null,
                    consumerTransport: null,
                    producers: new Map(),
                    consumers: new Map()
                });

                socket.join(roomId);
                
                // Notificar outros da sala
                socket.to(roomId).emit('participant-joined', { 
                    socketId: socket.id, 
                    username,
                    totalParticipants: room.participants.size 
                });

                log('join-room: sucesso', { socketId: socket.id, roomId });
                
                callback({
                    routerRtpCapabilities: room.router.rtpCapabilities,
                    iceServers: getIceServers(),
                    totalParticipants: room.participants.size
                });
            } catch (error) {
                logError('join-room: erro', error);
                callback({ error: error.message });
            }
        });

        socket.on('get-producers', (data, callback) => {
            log('get-producers: solicitado', { socketId: socket.id, roomId: currentRoomId });
            const room = getRoom(currentRoomId);
            if (!room) return callback({ producers: [] });

            const producers = [];
            for (const [id, participant] of room.participants.entries()) {
                if (id === socket.id) continue;
                for (const [producerId, producer] of participant.producers.entries()) {
                    producers.push({ producerId, socketId: id, username: participant.username });
                }
            }
            log('get-producers: retornando', { producersCount: producers.length });
            callback({ producers });
        });

        socket.on('create-transport', async ({ direction }, callback) => {
            log(`create-transport (${direction}): iniciado`, { socketId: socket.id });
            try {
                const room = getRoom(currentRoomId);
                const participant = room.participants.get(socket.id);
                
                const transport = await room.router.createWebRtcTransport(mediasoupConfig.webRtcTransport);
                
                if (direction === 'producer') {
                    participant.producerTransport = transport;
                } else {
                    participant.consumerTransport = transport;
                }

                transport.on('dtlsstatechange', dtlsState => {
                    log('WebRTC transport dtlsstatechange', { socketId: socket.id, direction, dtlsState });
                    if (dtlsState === 'closed') transport.close();
                });

                callback({
                    transportOptions: {
                        id: transport.id,
                        iceParameters: transport.iceParameters,
                        iceCandidates: transport.iceCandidates,
                        dtlsParameters: transport.dtlsParameters
                    }
                });
                log(`create-transport (${direction}): sucesso`, { transportId: transport.id });
            } catch (error) {
                logError(`create-transport (${direction}): erro`, error);
                callback({ error: error.message });
            }
        });

        socket.on('connect-transport', async ({ direction, dtlsParameters }, callback) => {
            log(`connect-transport (${direction}): iniciado`, { socketId: socket.id });
            try {
                const room = getRoom(currentRoomId);
                const participant = room.participants.get(socket.id);
                const transport = direction === 'producer' ? participant.producerTransport : participant.consumerTransport;
                
                await transport.connect({ dtlsParameters });
                callback({ success: true });
                log(`connect-transport (${direction}): conectado`, { transportId: transport.id });
            } catch (error) {
                logError(`connect-transport (${direction}): erro`, error);
                callback({ error: error.message });
            }
        });

        socket.on('produce', async ({ kind, rtpParameters }, callback) => {
            log('produce: iniciado', { socketId: socket.id, kind });
            try {
                const room = getRoom(currentRoomId);
                const participant = room.participants.get(socket.id);
                
                const producer = await participant.producerTransport.produce({ kind, rtpParameters });
                participant.producers.set(producer.id, producer);

                producer.on('transportclose', () => {
                    log('producer transportclose', { producerId: producer.id });
                    producer.close();
                    participant.producers.delete(producer.id);
                });

                callback({ id: producer.id });
                log('produce: sucesso', { producerId: producer.id });

                socket.to(currentRoomId).emit('screen-sharing-started', {
                    producerId: producer.id,
                    socketId: socket.id,
                    username: participant.username
                });
            } catch (error) {
                logError('produce: erro', error);
                callback({ error: error.message });
            }
        });

        socket.on('consume', async ({ producerId, rtpCapabilities }, callback) => {
            log('consume: iniciado', { socketId: socket.id, producerId });
            try {
                const room = getRoom(currentRoomId);
                const participant = room.participants.get(socket.id);

                if (!room.router.canConsume({ producerId, rtpCapabilities })) {
                    throw new Error('Não é possível consumir este producer');
                }

                const consumer = await participant.consumerTransport.consume({
                    producerId,
                    rtpCapabilities,
                    paused: true // Inicia pausado por recomendação do mediasoup
                });

                participant.consumers.set(consumer.id, consumer);

                consumer.on('transportclose', () => {
                    log('consumer transportclose', { consumerId: consumer.id });
                    consumer.close();
                    participant.consumers.delete(consumer.id);
                });

                consumer.on('producerclose', () => {
                    log('consumer producerclose', { consumerId: consumer.id });
                    socket.emit('screen-sharing-stopped', { producerId });
                    consumer.close();
                    participant.consumers.delete(consumer.id);
                });

                callback({
                    id: consumer.id,
                    producerId,
                    kind: consumer.kind,
                    rtpParameters: consumer.rtpParameters
                });
                log('consume: sucesso', { consumerId: consumer.id });
            } catch (error) {
                logError('consume: erro', error);
                callback({ error: error.message });
            }
        });

        socket.on('resume-consumer', async ({ consumerId }, callback) => {
            const room = getRoom(currentRoomId);
            const participant = room.participants.get(socket.id);
            const consumer = participant.consumers.get(consumerId);
            if (consumer) {
                await consumer.resume();
                callback({ success: true });
                log('resume-consumer: sucesso', { consumerId });
            } else {
                callback({ error: 'Consumer não encontrado' });
            }
        });

        socket.on('stop-sharing', ({ producerId }) => {
            log('stop-sharing: recebido', { socketId: socket.id, producerId });
            const room = getRoom(currentRoomId);
            if (!room) return;
            const participant = room.participants.get(socket.id);
            if (!participant) return;

            const producer = participant.producers.get(producerId);
            if (producer) {
                producer.close();
                participant.producers.delete(producerId);
                socket.to(currentRoomId).emit('screen-sharing-stopped', { producerId, socketId: socket.id });
                log('stop-sharing: processado', { producerId });
            }
        });

        socket.on('leave-room', () => {
            handleDisconnect();
        });

        socket.on('disconnect', () => {
            log('Socket desconectado', { socketId: socket.id });
            handleDisconnect();
        });

        function handleDisconnect() {
            if (currentRoomId) {
                const room = removeParticipant(currentRoomId, socket.id);
                if (room) {
                    socket.to(currentRoomId).emit('participant-left', { 
                        socketId: socket.id,
                        totalParticipants: room.participants.size 
                    });
                }
                currentRoomId = null;
            }
        }
    });
}
