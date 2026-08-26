export function log(event, data = null) {
    const timestamp = new Date().toISOString();
    if (data) {
        console.log(`[SERVER] [${timestamp}] ${event}`, data);
    } else {
        console.log(`[SERVER] [${timestamp}] ${event}`);
    }
}

export function logError(event, error) {
    const timestamp = new Date().toISOString();
    console.error(`[SERVER] [${timestamp}] ERROR: ${event}`, error);
}
