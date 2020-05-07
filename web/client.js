const mediasoup = require('mediasoup-client');

const $ = document.querySelector.bind(document);
const $btnConnect = $('#btn_connect');
const $btnRegister = $('#btn_register');
const $btnCallto = $('#btn_callto');

$btnConnect.addEventListener('click', connect);
$btnRegister.addEventListener('click', register);
$btnCallto.addEventListener('click', callto);

let device;
let socket;

const urlParams = new URLSearchParams(window.location.search);
const userId = urlParams.get('userId');

const promise = function(socket) {
  return function request(type, data = {}) {
    return new Promise((resolve) => {
      socket.emit(type, data, resolve);
    });
  }
};

async function register() {
  if(!userId) { console.log('no userId') }
  const response = await socket.request('register', {userId});
  console.log('register', response);
}

async function callto() {
  const response = await socket.request('callto', {userId: 'lala2'});
  console.log('callto', response);
  // publish()
}

async function connect() {
  
  const opts = {
    path: '/server',
    transports: ['websocket'],
  };

  const serverUrl = 'https://vc.ofee.ru:3000';
  socket = io(serverUrl, opts);
  socket.request = promise(socket);

  socket.on('connect', async () => {
    // $txtConnection.innerHTML = 'Connected';
    // $fsPublish.disabled = false;
    // $fsSubscribe.disabled = false;

    const data = await socket.request('getRouterRtpCapabilities');
    console.log('----', data);
    const q = await loadDevice(data);
    console.log('----', q);
  });


  socket.on('callto', async (data) => {
    console.log('callto', data);
    socket.emit('accept', data);
  });

  socket.on('publish', async() =>{
    publish();
  });

  socket.on('subscribe', async() =>{
    subscribe();
  });

  socket.on('disconnect', () => {
    /*$txtConnection.innerHTML = 'Disconnected';
    $btnConnect.disabled = false;
    $fsPublish.disabled = true;
    $fsSubscribe.disabled = true;
    */
  });

  socket.on('connect_error', (error) => {
    console.error('could not connect to %s%s (%s)', serverUrl, opts.path, error.message);
    $txtConnection.innerHTML = 'Connection failed';
    $btnConnect.disabled = false;
  });
}

async function loadDevice(routerRtpCapabilities) {
  try {
    device = new mediasoup.Device();
  } catch (error) {
    if (error.name === 'UnsupportedError') {
      console.error('browser not supported');
    }
  }
  await device.load({ routerRtpCapabilities });
}

async function publish() {
  const isWebcam = true; //(e.target.id === 'btn_webcam');
  // $txtPublish = isWebcam ? $txtWebcam : $txtScreen;

  const data = await socket.request('createProducerTransport', {
    forceTcp: false,
    rtpCapabilities: device.rtpCapabilities,
  });
  if (data.error) {
    console.error(data.error);
    return;
  }

  const transport = device.createSendTransport(data);
  transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
    socket.request('connectProducerTransport', { dtlsParameters })
      .then(callback)
      .catch(errback);
  });

  transport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
    try {
      const { id } = await socket.request('produce', {
        transportId: transport.id,
        kind,
        rtpParameters,
      });
      callback({ id });
    } catch (err) {
      errback(err);
    }
  });

  transport.on('connectionstatechange', (state) => {
    switch (state) {
      case 'connecting':
        console.log('publishing...')
        //$txtPublish.innerHTML = 'publishing...';
        //$fsPublish.disabled = true;
        //$fsSubscribe.disabled = true;
      break;

      case 'connected':
        document.querySelector('#local_video').srcObject = stream;
        //$txtPublish.innerHTML = 'published';
        //$fsPublish.disabled = true;
        //$fsSubscribe.disabled = false;
      break;

      case 'failed':
        transport.close();
        //$txtPublish.innerHTML = 'failed';
        //$fsPublish.disabled = false;
        //$fsSubscribe.disabled = true;
      break;

      default: break;
    }
  });

  let stream;
  try {
    stream = await getUserMedia(transport, isWebcam);
    const track = stream.getVideoTracks()[0];
    const params = { track };

    /*
    if ($chkSimulcast.checked) {
      params.encodings = [
        { maxBitrate: 100000 },
        { maxBitrate: 300000 },
        { maxBitrate: 900000 },
      ];
      params.codecOptions = {
        videoGoogleStartBitrate : 1000
      };
    }
    */
    producer = await transport.produce(params);
  } catch (err) {
    // $txtPublish.innerHTML = 'failed';
  }
}

async function getUserMedia(transport, isWebcam) {
  if (!device.canProduce('video')) {
    console.error('cannot produce video');
    return;
  }

  let stream;
  try {
    stream = isWebcam ?
      await navigator.mediaDevices.getUserMedia({ audio: true, video: true }) :
      await navigator.mediaDevices.getDisplayMedia({ video: true });
  } catch (err) {
    console.error('getUserMedia() failed:', err.message);
    throw err;
  }
  return stream;
}

async function subscribe() {
  const data = await socket.request('createConsumerTransport', {
    forceTcp: false,
  });
  if (data.error) {
    console.error(data.error);
    return;
  }

  const transport = device.createRecvTransport(data);
  transport.on('connect', ({ dtlsParameters }, callback, errback) => {
    socket.request('connectConsumerTransport', {
      transportId: transport.id,
      dtlsParameters
    })
      .then(callback)
      .catch(errback);
  });

  transport.on('connectionstatechange', async (state) => {
    switch (state) {
      case 'connecting':
        console.log('subscribing...')
        // $txtSubscription.innerHTML = 'subscribing...';
        // $fsSubscribe.disabled = true;
        break;

      case 'connected':
        document.querySelector('#remote_video').srcObject = await stream;
        await socket.request('resume');
        //$txtSubscription.innerHTML = 'subscribed';
        //$fsSubscribe.disabled = true;
        break;

      case 'failed':
        transport.close();
        // $txtSubscription.innerHTML = 'failed';
        // $fsSubscribe.disabled = false;
        break;

      default: break;
    }
  });

  const stream = consume(transport);
}

async function consume(transport) {
  const { rtpCapabilities } = device;
  const data = await socket.request('consume', { rtpCapabilities });
  const {
    producerId,
    id,
    kind,
    rtpParameters,
  } = data;

  let codecOptions = {};
  const consumer = await transport.consume({
    id,
    producerId,
    kind,
    rtpParameters,
    codecOptions,
  });
  const stream = new MediaStream();
  stream.addTrack(consumer.track);
  return stream;
}
