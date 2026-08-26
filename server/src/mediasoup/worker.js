import * as mediasoup from 'mediasoup';
import { mediasoupConfig } from '../config/mediasoup.config.js';
import { log, logError } from '../utils/logger.js';

let worker;

export async function createWorker() {
    log('createWorker: iniciado');
    try {
        worker = await mediasoup.createWorker({
            logLevel: mediasoupConfig.worker.logLevel,
            logTags: mediasoupConfig.worker.logTags,
            rtcMinPort: mediasoupConfig.worker.rtcMinPort,
            rtcMaxPort: mediasoupConfig.worker.rtcMaxPort,
        });

        worker.on('died', () => {
            logError('mediasoup worker morreu', 'Encerrando processo...');
            setTimeout(() => process.exit(1), 2000);
        });

        log('createWorker: sucesso', { workerId: worker.pid });
        return worker;
    } catch (error) {
        logError('createWorker: erro', error);
        throw error;
    }
}

export function getWorker() {
    return worker;
}
