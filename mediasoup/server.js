const mediasoup = require('mediasoup');
const fs = require('fs');
const https = require('https');
const socketIO = require('socket.io');
const config = require('config');

// Global variables
let worker;
let webServer;
let socketServer;
let producer;
let consumer;
let producerTransport;
let consumerTransport;
let mediasoupRouter;


let registry = [];

let connections = [];

class Connection {
  constructor () {
    this.id = 'test';
    this.state = 'init';
  }

  async appendPeerA (peerA) {
    this.peerA = peerA;
  }

  async appendPeerB (peerB) {
    this.peerB = peerB;
  }

  getPeerA () {
    return this.peerA;
  }

  getPeerB () {
    return this.peerB;
  }

}


class Peer  {

  constructor ({userId, router, socket}) {
    this.router = router;
    this.socket = socket;
    this.userId = userId;

    this.initSocket();
  }

  setOtherPeer (peer) {
    this.otherPeer = peer;
  }

  getProducer () {
    return this.producer;
  }

  initSocket () {
    this.socket.on('createProducerTransport', async (data, callback) => {
      console.log('createProducerTransport data', data);
      try {
        const { transport, params } = await this.createWebRtcTransport();
        this.producerTransport = transport;
        callback(params);
      } catch (err) {
        console.error(err);
        callback({ error: err.message });
      }
    });

    this.socket.on('createConsumerTransport', async (data, callback) => {
      console.log('createConsumerTransport data', data);
      try {
        const { transport, params } = await this.createWebRtcTransport();
        this.consumerTransport = transport;
        callback(params);
      } catch (err) {
        console.error(err);
        callback({ error: err.message });
      }
    });

    this.socket.on('connectProducerTransport', async (data, callback) => {
      await this.producerTransport.connect({ dtlsParameters: data.dtlsParameters });
      callback();
    });

    this.socket.on('connectConsumerTransport', async (data, callback) => {
      await this.consumerTransport.connect({ dtlsParameters: data.dtlsParameters });
      callback();
    });

    this.socket.on('produce', async (data, callback) => {
      console.log('produce...');
      const {kind, rtpParameters} = data;
      this.producer = await this.producerTransport.produce({ kind, rtpParameters });
      console.log('produce in produce', this.producer);
      callback({ id: this.producer.id });
    });

    this.socket.on('consume', async (data, callback) => {
      const producer = this.otherPeer.getProducer();
      callback(await this.consume(producer, data.rtpCapabilities));
    });
  }

  getSocket () {
    return this.socket;
  }

  getUserId () {
    return this.userId;
  }

/*
  async createConsumerTransport () {
    const { transport, params } = await createWebRtcTransport();
    this.consumerTransport = transport;
    return {transport, params};
  }

  async  createProducerTransport () {
    const { transport, params } = await createWebRtcTransport();
    this.producerTransport = transport;
    return {transport, params};
  }

  async  produce (data) {
    const {kind, rtpParameters} = data;
    this.producer = await producerTransport.produce({ kind, rtpParameters });
    return this.producer;
  }
*/

  async  consume (producer, rtpCapabilities) {
    console.log('producer', producer);
    if (!this.router.canConsume(
      {
        producerId: producer.id,
        rtpCapabilities,
      })
    ) {
      console.error('can not consume');
      return;
    }
    try {
      this.consumer = await this.consumerTransport.consume({
        producerId: producer.id,
        rtpCapabilities,
        // paused: producer.kind === 'video',
      });
    } catch (error) {
      console.error('consume failed', error);
      return;
    }    

    return {
      producerId: producer.id,
      id: this.consumer.id,
      kind: this.consumer.kind,
      rtpParameters: this.consumer.rtpParameters,
      type: this.consumer.type,
      producerPaused: this.consumer.producerPaused
    };
  }

  async createWebRtcTransport() {
    const {
      // maxIncomingBitrate,
      initialAvailableOutgoingBitrate
    } = config.mediasoup.webRtcTransport;

    const transport = await mediasoupRouter.createWebRtcTransport({
      listenIps: config.mediasoup.webRtcTransport.listenIps,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate,
    });
    /*
    if (maxIncomingBitrate) {
      try {
        await transport.setMaxIncomingBitrate(maxIncomingBitrate);
      } catch (error) {
      }
    }
    */
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

    socket.on('getRouterRtpCapabilities', (data, callback) => {
      console.log('get rtp capabilities from mediasource', data);
      callback(mediasoupRouter.rtpCapabilities);
    });

    socket.on('register', (data, callback) => {
      console.log('register', data);

      registry.push({
        socketId: socket.id, 
        userId: data.userId,
        socket,
        });

      console.log('registry', registry);
      callback('registered', data);
    });

    socket.on('callto', (data, callback) => {
      console.log('callto', data);
      const b = registry.find(item => item.userId === data.userId);
      console.log('b', b);
      const a = registry.find(item => item.socketId === socket.id);

      if (!b) return;

      const peerA  = new Peer({
        router: mediasoupRouter, 
        userId: a.userId,
        socket: a.socket,
      });

      const peerB  = new Peer({
        router: mediasoupRouter, 
        userId: b.userId,
        socket: b.socket,
      });


      console.log(' ---- 1');
      const connection = new Connection();
      peerA.setOtherPeer(peerB);
      peerB.setOtherPeer(peerA);
      connection.appendPeerA(peerA);
      connection.appendPeerB(peerB);      

      console.log(' ---- 2')
      connections.push(connection);
      console.log(' ---- 3')
      socketServer.to(b.socketId).emit('callto', {id: connection.id});
      console.log(' ---- 4')
      
      callback('callto_resp', {id: connection.id});
    });

    socket.on('accept', (data, callback) => {
      const connection = connections.find(item => item.id === data.id);
      console.log('connection', connection);

      if (!connection) return;
      connection.getPeerA().getSocket().emit('publish');
      connection.getPeerB().getSocket().emit('publish');
      setTimeout(()=> {
        console.log('timeout out')
        connection.getPeerA().getSocket().emit('subscribe');
        connection.getPeerB().getSocket().emit('subscribe');
      }, 5000)
    })

    socket.on('connect_error', (err) => {
      console.error('client connection error', err);
    });

    
    /*
    socket.on('createProducerTransport', async (data, callback) => {
      console.log('data', data);
      try {
        const { transport, params } = await createWebRtcTransport();
        producerTransport = transport;
        callback(params);
      } catch (err) {
        console.error(err);
        callback({ error: err.message });
      }
    });

    socket.on('createConsumerTransport', async (data, callback) => {
      try {
        const { transport, params } = await createWebRtcTransport();
        consumerTransport = transport;
        callback(params);
      } catch (err) {
        console.error(err);
        callback({ error: err.message });
      }
    });

    socket.on('connectProducerTransport', async (data, callback) => {
      await producerTransport.connect({ dtlsParameters: data.dtlsParameters });
      callback();
    });

    socket.on('connectConsumerTransport', async (data, callback) => {
      await consumerTransport.connect({ dtlsParameters: data.dtlsParameters });
      callback();
    });

    socket.on('produce', async (data, callback) => {
      console.log('produce...');
      const {kind, rtpParameters} = data;
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
    */
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

  const mediaCodecs = config.mediasoup.router.mediaCodecs;
  mediasoupRouter = await worker.createRouter({ mediaCodecs });
}

