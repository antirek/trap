const express = require('express');
const config = require('config');
const {createServer} = require('http');
const path = require('path');
const socketIo = require('socket.io');
const app = express();

const server = createServer(app);
const io = socketIo(server);
app.use(express.json());

app.set('views', path.join(__dirname,'views'));
app.set('view engine', 'pug');

app.use('/static', express['static'](path.join(__dirname, '../node_modules')));
app.use('/public', express['static'](path.join(__dirname, '/public')));

app.get('/', (req, res) => {
    res.render('index', {

    });
});

server.listen(config.get('port'), () => {
  console.log('start app on port', config.get('port'));
});
