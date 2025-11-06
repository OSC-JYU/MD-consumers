import Hapi from '@hapi/hapi';

/**
 * Creates and configures a Hapi server with the /start endpoint
 * @param {number} port - Port number for the server (default: 3000)
 * @returns {Promise<Hapi.Server>} Configured Hapi server
 */
export async function createServer(port = 3000) {
    const server = Hapi.server({
        port: port,
        host: 'localhost',
        routes: {
            cors: {
                origin: ['*']
            }
        }
    });

    // Add the /start endpoint
    server.route({
        method: 'POST',
        path: '/start',
        handler: async (request, h) => {
            try {
                // Parse the JSON data from the request body
                const jsonData = request.payload;
                console.log('Received JSON data:', JSON.stringify(jsonData, null, 2));
                
                // Check if topic is provided
                if (!jsonData.topic) {
                    return h.response({
                        success: false,
                        message: 'Topic is required in the request body',
                        example: { topic: 'md-imaginary' }
                    }).code(400);
                }
                
                // Import the startNATSConsumer function
                const { startNATSConsumer, isTopicRunning } = await import('./index.mjs');
                
                // Check if consumer is already running
                if (isTopicRunning(jsonData.topic)) {
                    return h.response({
                        success: false,
                        message: `Consumer is already running for topic: ${jsonData.topic}`,
                        topic: jsonData.topic
                    }).code(409);
                }
                
                // Start the NATS consumer
                await startNATSConsumer(jsonData);
                
                // Return success response
                return h.response({
                    success: true,
                    message: 'NATS consumer started successfully',
                    topic: jsonData.topic,
                    receivedData: jsonData
                }).code(200);
                
            } catch (error) {
                console.error('Error starting NATS consumer:', error.message);
                return h.response({
                    success: false,
                    message: 'Error starting NATS consumer',
                    error: error.message
                }).code(500);
            }
        },
        options: {
            payload: {
                parse: true,
                allow: 'application/json'
            }
        }
    });

    // Add a simple health check endpoint
    server.route({
        method: 'GET',
        path: '/health',
        handler: (request, h) => {
            return h.response({
                status: 'ok',
                timestamp: new Date().toISOString()
            }).code(200);
        }
    });

    // Add a status endpoint to check active consumers
    server.route({
        method: 'GET',
        path: '/status',
        handler: async (request, h) => {
            try {
                const { getActiveTopics } = await import('./index.mjs');
                const activeTopics = getActiveTopics();
                return h.response({
                    activeTopics: activeTopics,
                    consumerCount: activeTopics.length,
                    timestamp: new Date().toISOString()
                }).code(200);
            } catch (error) {
                return h.response({
                    error: 'Failed to get status',
                    message: error.message
                }).code(500);
            }
        }
    });

    // Add an info endpoint to get detailed information about all consumers
    server.route({
        method: 'GET',
        path: '/info',
        handler: async (request, h) => {
            try {
                const { getConsumersInfo, getActiveTopics } = await import('./index.mjs');
                const consumers = getConsumersInfo();
                const activeTopics = getActiveTopics();
                return h.response({
                    consumers: consumers,
                    activeTopics: activeTopics,
                    consumerCount: consumers.length,
                    timestamp: new Date().toISOString()
                }).code(200);
            } catch (error) {
                return h.response({
                    error: 'Failed to get consumer info',
                    message: error.message
                }).code(500);
            }
        }
    });

    // Add a stop endpoint to stop a specific topic
    server.route({
        method: 'POST',
        path: '/stop',
        handler: async (request, h) => {
            try {
                // Parse the JSON data from the request body
                const jsonData = request.payload;
                console.log('Received stop request:', JSON.stringify(jsonData, null, 2));
                
                // Check if topic is provided
                if (!jsonData.topic) {
                    return h.response({
                        success: false,
                        message: 'Topic is required in the request body',
                        example: { topic: 'md-imaginary' }
                    }).code(400);
                }
                
                // Import the stopNATSConsumer function
                const { stopNATSConsumer, isTopicRunning } = await import('./index.mjs');
                
                // Check if consumer is running
                if (!isTopicRunning(jsonData.topic)) {
                    return h.response({
                        success: false,
                        message: `No consumer running for topic: ${jsonData.topic}`,
                        topic: jsonData.topic
                    }).code(404);
                }
                
                // Stop the NATS consumer
                await stopNATSConsumer(jsonData.topic);
                
                // Return success response
                return h.response({
                    success: true,
                    message: 'NATS consumer stopped successfully',
                    topic: jsonData.topic
                }).code(200);
                
            } catch (error) {
                console.error('Error stopping NATS consumer:', error.message);
                return h.response({
                    success: false,
                    message: 'Error stopping NATS consumer',
                    error: error.message
                }).code(500);
            }
        },
        options: {
            payload: {
                parse: true,
                allow: 'application/json'
            }
        }
    });

    return server;
}

/**
 * Starts the Hapi server
 * @param {number} port - Port number for the server (default: 3000)
 * @returns {Promise<Hapi.Server>} Started server
 */
export async function startServer(port = 3000) {
    const server = await createServer(port);
    
    await server.start();
    console.log(`Hapi server running on ${server.info.uri}`);
    
    return server;
}
