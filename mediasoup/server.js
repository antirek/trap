const mediasoup = require('mediasoup');
const fs = require('fs');
const https = require('https');
const socketIO = require('socket.io');
const config = require('config');

// Global variables
let worker;
let webServer;
let socketServer;

/*let producer;
let consumer;
let producerTransport;
let consumerTransport;
*/
let mediasoupRouter;


let registry = [];

let connections = [];


class Connection {
  constructor({worker, config}) {
    const mediaCodecs = config.mediasoup.router.mediaCodecs;
    this.Router = await worker.createRouter({ mediaCodecs });

    this.id = 'test';
    this.state = 'init';
  }

  getInfo() {
    return {
      id: this.id,
      from: this.A.name,
      fromSocket: this.A.socketId,
      to: this.B.name,
      toSocket: this.B.socketId,
    }
  }

  getFromSocket () {
    return this.A.socketId;
  }

  getToSocket () {
    return this.B.socketId;
  }

  setState(newState) {
    this.state = newState;
  }

  setA({name, socketId}) {
    this.A.name = name;
    this.A.socketId = socketId;
  }

  setB({name, socketId}) {
    this.B.name = name;
    this.B.socketId = socketId;
  }

  async createAProducerTransport() {
    this.A.producerTransport = await createWebRtcTransport();
    return this.A.producerTransport;
  }

  async createBProducerTransport() {
    this.B.producerTransport = await createWebRtcTransport();
    return this.B.producerTransport;
  }

  async createAConsumerTransport() {
    this.A.consumerTransport = await createWebRtcTransport();
    return this.A.producerTransport;
  }

  async createBConsumerTransport() {
    this.B.consumerTransport = await createWebRtcTransport();
    return this.B.producerTransport;
  }

  async connectAProducerTransport (data) {
    return await this.A.producerTransport.connect({ dtlsParameters: data.dtlsParameters });
  }

  async connectBProducerTransport (data) {
    return await this.B.producerTransport.connect({ dtlsParameters: data.dtlsParameters });
  }

  async connectAConsumerTransport (data) {
    return await this.A.consumerTransport.connect({ dtlsParameters: data.dtlsParameters });
  }

  async connectBConsumerTransport (data) {
    return await this.B.consumerTransport.connect({ dtlsParameters: data.dtlsParameters });
  }


  async function createWebRtcTransport() {
    const {
      maxIncomingBitrate,
      initialAvailableOutgoingBitrate
    } = config.mediasoup.webRtcTransport;

    const transport = await this.Router.createWebRtcTransport({
      listenIps: config.mediasoup.webRtcTransport.listenIps,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate,
    });
    if (maxIncomingBitrate) {
      try {
        await transport.setMaxIncomingBitrate(maxIncomingBitrate);
      } catch (error) {
      }
    }
    return {
      transport,
      params: {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters
      },
    };
  }

  getRTPCapabilities() {
    return this.Router.rtpCapabilities;
  }


  async function createConsumer(consumerTransport, producer, rtpCapabilities) {
    console.log('producer', producer);
    if (!this.Router.canConsume(
      {
        producerId: producer.id,
        rtpCapabilities,
      })
    ) {
      console.error('can not consume');
      return;
    }
    try {
      consumer = await consumerTransport.consume({
        producerId: producer.id,
        rtpCapabilities,
        paused: producer.kind === 'video',
      });
    } catch (error) {
      console.error('consume failed', error);
      return;
    }    

    return {
      producerId: producer.id,
      id: consumer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      type: consumer.type,
      producerPaused: consumer.producerPaused
    };
  }


}


(async () => {
  try {
    await runWebServer();
    await runSocketServer();
    await runMediasoupWorker();
  } catch (err) {
    console.error(err);
  }
})();


async function runWebServer() {
  const { sslKey, sslCrt } = config;
  if (!fs.existsSync(sslKey) || !fs.existsSync(sslCrt)) {
    console.error('SSL files are not found. check your config.js file');
    process.exit(0);
  }
  const options = {
    cert: fs.readFileSync(sslCrt),
    key: fs.readFileSync(sslKey),
  };
  webServer = https.createServer(options);
  webServer.on('error', (err) => {
    console.error('starting web server failed:', err.message);
  });

  await new Promise((resolve) => {
    const { listenIp, listenPort } = config;
    webServer.listen(listenPort, listenIp, () => {
      const listenIps = config.mediasoup.webRtcTransport.listenIps[0];
      const ip = listenIps.announcedIp || listenIps.ip;
      console.log('server is running');
      console.log(`open https://${ip}:${listenPort} in your web browser`);
      resolve();
    });
  });
}

async function runSocketServer() {
  socketServer = socketIO(webServer, {
    serveClient: false,
    path: '/server',
    log: false,
  });

  socketServer.on('connection', (socket) => {
    console.log('client connected');

    socket.on('disconnect', () => {
      console.log('client disconnected');
    });

    socket.on('register', (data, callback) => {
      console.log('register', data);
      registry.push({'socketId': socket.id, 'userId': data.userId});
      console.log('registry', registry);
      callback('registered', data);
    });

    socket.on('callto', (data, callback) => {
      console.log('callto', data);
      const b = registry.find(item => item.userId === data.userId);
      console.log('b', b);
      const a = registry.find(item => item.socketId === socket.id);

      if (!b) return;
      const connection = new Connection({worker, config});
      connections.push(connection);
      socketServer.to(b.socketId).emit('callto', connection.getInfo());
      
      callback('callto_resp', connection.getInfo());
    });

    socket.on('accept', (data, callback) => {
      const connection = connections.find(conn => conn.getInfo().id === data.id);
      console.log('connection', connection);
      if (!connection) return;

      socketServer.to(connection.getFromSocket()).emit('publish');
      setTimeout(()=>{
        console.log('timeout out')
        socketServer.to(connection.getToSocket()).emit('subscribe');
      }, 5000)
    })

    socket.on('connect_error', (err) => {
      console.error('client connection error', err);
    });

    socket.on('getRouterRtpCapabilities', (data, callback) => {
      const connection = connections.find(conn => conn.getInfo().id === data.id);
      console.log('get rtp capabilities from mediasource', data);

      callback(connection.getRTPCapabilities());
    });

    socket.on('createAProducerTransport', async (data, callback) => {
      const connection = connections.find(conn => conn.getFromSocket() === socket.id);
      console.log('data', data);
      try {
        const { transport, params } = await connection.createAProducerTransport();
        callback(params);
      } catch (err) {
        console.error(err);
        callback({ error: err.message });
      }
    });

    socket.on('createBProducerTransport', async (data, callback) => {
      const connection = connections.find(conn => conn.getToSocket() === socket.id);
      console.log('data', data);
      try {
        const { transport, params } = await connection.createBProducerTransport();
        callback(params);
      } catch (err) {
        console.error(err);
        callback({ error: err.message });
      }
    });

    socket.on('createAConsumerTransport', async (data, callback) => {
      const connection = connections.find(conn => conn.getFromSocket() === socket.id);
      try {
        const { transport, params } = await connection.createAConsumerTransport();
        callback(params);
      } catch (err) {
        console.error(err);
        callback({ error: err.message });
      }
    });

    socket.on('createBConsumerTransport', async (data, callback) => {
      const connection = connections.find(conn => conn.getToSocket() === socket.id);
      try {
        const { transport, params } = await connection.createBConsumerTransport();
        callback(params);
      } catch (err) {
        console.error(err);
        callback({ error: err.message });
      }
    });

    socket.on('connectAProducerTransport', async (data, callback) => {
      const connection = connections.find(conn => conn.getFromSocket() === socket.id);
      await connection.connectAProducerTransport(data);
      callback();
    });

    socket.on('connectAConsumerTransport', async (data, callback) => {
      const connection = connections.find(conn => conn.getFromSocket() === socket.id);
      await connection.connectAConsumerTransport(data);
      callback();
    });

    socket.on('connectBProducerTransport', async (data, callback) => {
      const connection = connections.find(conn => conn.getToSocket() === socket.id);
      await connection.connectBProducerTransport(data);
      callback();
    });

    socket.on('connectBConsumerTransport', async (data, callback) => {
      const connection = connections.find(conn => conn.getToSocket() === socket.id);
      await connection.connectBConsumerTransport(data);
      callback();
    });


    socket.on('produceA', async (data, callback) => {
      console.log('produce A...');
      const {kind, rtpParameters} = data;

      const conn = connections.find(conn => conn.getFromSocket() === socket.id);
      const producerTransport = conn.fromProducerTransport;
      

      producer = await producerTransport.produce({ kind, rtpParameters });
      console.log('produce in produce', producer);
      callback({ id: producer.id });

      // inform clients about new producer
      // socket.broadcast.emit('newProducer');
    });

    socket.on('consume', async (data, callback) => {
      callback(await createConsumer(producer, data.rtpCapabilities));
    });

    socket.on('resume', async (data, callback) => {
      await consumer.resume();
      callback();
    });
  });
}

async function runMediasoupWorker() {
  worker = await mediasoup.createWorker({
    logLevel: config.mediasoup.worker.logLevel,
    logTags: config.mediasoup.worker.logTags,
    rtcMinPort: config.mediasoup.worker.rtcMinPort,
    rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
  });

  worker.on('died', () => {
    console.error('mediasoup worker died, exiting in 2 seconds... [pid:%d]', worker.pid);
    setTimeout(() => process.exit(1), 2000);
  });

}

