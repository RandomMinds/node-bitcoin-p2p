var sys = require('sys');
var events = require('events');
var logger = require('./logger');
var Binary = require('./binary');
var Util = require('./util');

var Connection = exports.Connection = function Connection(node, socket, peer) {
  events.EventEmitter.call(this);

  this.node = node;
  this.socket = socket;
  this.peer = peer;

  // A connection is considered "active" once we have received verack
  this.active = false;
  // The version incoming packages are interpreted as
  this.recvVer = 0;
  // The version outgoing packages are sent as
  this.sendVer = 0;
  // The (claimed) height of the remote peer's block chain
  this.bestHeight = 0;
  // Is this an inbound connection?
  this.inbound = !!socket.server;
  // Have we sent a getaddr on this connection?
  this.getaddr = false;

  // Starting 20 Feb 2012, Version 0.2 is obsolete
  // This is the same behavior as the official client
  if (new Date().getTime() > 1329696000000) {
    this.recvVer = 209;
    this.sendVer = 209;
  }

  this.setupHandlers();
};

sys.inherits(Connection, events.EventEmitter);

Connection.prototype.setupHandlers = function () {
  this.socket.addListener('connect', this.handleConnect.bind(this));
  this.socket.addListener('error', this.handleError.bind(this));
  this.socket.addListener('end', this.handleDisconnect.bind(this));
  this.socket.addListener('data', (function (data) {
    var dumpLen = 35;
    logger.netdbg('['+this.peer+'] '+
                  'Recieved '+data.length+' bytes of data:');
    logger.netdbg('... '+ data.slice(0, dumpLen > data.length ?
                                     data.length : dumpLen).toHex() +
                  (data.length > dumpLen ? '...' : ''));
  }).bind(this));

  var parser = Binary.stream(this.socket);
  this.setupParser(parser, this.handleMessage.bind(this));
};

Connection.prototype.handleConnect = function () {
  this.sendVersion();
  this.emit('connect', {
    conn: this,
    socket: this.socket,
    peer: this.peer
  });
};

Connection.prototype.handleError = function (err) {
  if (err.errno == 111) { // ECONNREFUSED
    logger.info('Connection refused for '+this.peer);
  } else {
    logger.warn(err);
  }
  this.emit('error', {
    conn: this,
    socket: this.socket,
    peer: this.peer,
    err: err
  });
};

Connection.prototype.handleDisconnect = function () {
  this.emit('disconnect', {
    conn: this,
    socket: this.socket,
    peer: this.peer
  });
};

Connection.prototype.handleMessage = function (message) {
  if (!message) {
    // Parser was unable to make sense of the message, drop it
    return;
  }

  try {
    switch (message.command) {
    case 'version':
      if (message.version >= 209) {
        this.sendMessage('verack', new Buffer([]));
      }
      this.sendVer = Math.min(message.version, this.node.version);
      if (message.version < 209) {
        this.recvVer = Math.min(message.version, this.node.version);
      } else {
        // We won't start expecting a checksum until after we've received
        // the "verack" message.
        this.once('verack', (function () {
          this.recvVer = message.version;
        }).bind(this));
      }
      this.bestHeight = message.start_height;
      break;

    case 'verack':
      this.recvVer = Math.min(message.version, this.node.version);
      this.active = true;
    }

    this.emit(message.command, {
      conn: this,
      socket: this.socket,
      peer: this.peer,
      message: message
    });
  } catch (e) {
    logger.error('Error while handling message '+message.command+' from ' +
                 this.peer + ':\n' +
                 (e.stack ? e.stack : e.toString()));
  }
};

Connection.prototype.sendVersion = function () {
  var put = Binary.put();
  put.word32le(this.node.version); // version
  put.word64le(1); // services
  put.word64le(Math.round(new Date().getTime()/1000)); // timestamp
  put.pad(26); // addr_me
  put.pad(26); // addr_you
  put.put(this.node.nonce);
  put.word8(0);
  put.word32le(10);

  this.sendMessage('version', put.buffer());
};

Connection.prototype.sendGetBlocks = function (starts, stop) {
  var put = Binary.put();
  put.word32le(this.sendVer);

  put.var_uint(starts.length);
  for (var i = 0; i < starts.length; i++) {
    if (starts[i].length != 32) {
      throw new Error('Invalid hash length');
    }

    put.put(starts[i]);
  }

  var stopBuffer = new Buffer(stop, 'binary');
  if (stopBuffer.length != 32) {
    throw new Error('Invalid hash length');
  }

  put.put(stopBuffer);

  this.sendMessage('getblocks', put.buffer());
};

Connection.prototype.sendGetData = function (invs) {
  var put = Binary.put();

  put.var_uint(invs.length);
  for (var i = 0; i < invs.length; i++) {
    put.word32le(invs[i].type);
    put.put(invs[i].hash);
  }

  this.sendMessage('getdata', put.buffer());
};

Connection.prototype.sendGetAddr = function (invs) {
  var put = Binary.put();

  this.sendMessage('getaddr', put.buffer());
};

Connection.prototype.sendInv = function (data) {
  if (!Array.isArray(data)) {
    data = [data];
  }

  var put = Binary.put();

  put.var_uint(data.length);
  data.forEach(function (value) {
    if (value.collection.name == 'blocks') {
      // Block
      put.word32le(2); // MSG_BLOCK
    } else {
      // Transaction
      put.word32le(1); // MSG_TX
    }
    put.put(value.getHash());
  });

  this.sendMessage('inv', put.buffer());
};

Connection.prototype.sendTx = function (tx) {
  this.sendMessage('tx', tx.serialize());
};

Connection.prototype.sendBlock = function (block, txs) {
  var put = Binary.put();

  // Block header
  put.put(block.getHeader());

  // List of transactions
  put.var_uint(txs.length);
  txs.forEach(function (tx) {
    put.put(tx.serialize());
  });

  this.sendMessage('block', put.buffer());
};

Connection.prototype.sendMessage = function (command, payload) {
  try {
    var magic = this.node.cfg.network.magicBytes;

    var commandBuf = new Buffer(command, 'ascii');
    if (commandBuf.length > 12) {
      throw 'Command name too long';
    }

    var checksum;
    if (this.sendVer >= 209) {
      checksum = Util.twoSha256(payload).slice(0, 4);
    } else {
      checksum = new Buffer([]);
    }

    var message = Binary.put();           // -- HEADER --
    message.put(magic);                   // magic bytes
    message.put(commandBuf);              // command name
    message.pad(12 - commandBuf.length);  // zero-padded
    message.word32le(payload.length);     // payload length
    message.put(checksum);                // checksum
    // -- BODY --
    message.put(payload);                 // payload data

    var buffer = message.buffer();

    logger.netdbg('['+this.peer+'] '+
                  "Sending message "+command+" ("+payload.length+" bytes)");

    this.socket.write(buffer);
  } catch (err) {
    // TODO: We should catch this error one level higher in order to better
    //       determine how to react to it. For now though, ignoring it will do.
    logger.error("Error while sending message to peer "+this.peer+": "+
                 (err.stack ? err.stack : err.toString()));
  }
};

Connection.prototype.setupParser = function (parser, callback) {
  var self = this;

  var magic = this.node.cfg.network.magicBytes;

  parser.loop(function (end) {
    var vars = this.vars;

    this.scan('garbage', magic); // magic
    this.buffer('command', 12);
    this.word32le('payload_len');

    if (self.recvVer >= 209) {
      this.buffer('checksum', 4);
    }

    this.buffer('payload', 'payload_len');

    this.tap(function (vars) {
      if (vars.garbage.length) {
        logger.netdbg('['+self.peer+'] '+
                      'Received '+vars.garbage.length+
                      ' bytes of inter-message garbage: ');
        logger.netdbg('... '+vars.garbage);
      }

      // Convert command name to string and remove trailing \0
      var command = vars.command.toString('ascii').replace(/\0+$/,"");

      logger.netdbg('['+self.peer+'] ' +
                    "Received message " + command +
                    " (" + vars.payload_len + " bytes)");

      if (vars.payload.length != vars.payload_len) {
        logger.error('['+self.peer+'] '+
                     'Payload has incorrect length');
        return;
      }

      if ("undefined" !== typeof vars.checksum) {
        var checksum = Util.twoSha256(vars.payload).slice(0, 4);
        if (checksum.compare(vars.checksum) !== 0) {
          logger.error('['+self.peer+'] '+
                       'Checksum failed',
                       {cmd: command,
                        expected: checksum.toHex(),
                        actual: vars.checksum.toHex()});
          return;
        }
      }

      var message = Connection.parseMessage(command, vars.payload);
      callback(message);
    });
  });
};

Connection.parseMessage = function (command, payload) {
  var parser = Binary.parse(payload);

  parser.vars.command = command;

  switch (command) {
  case 'version': // https://en.bitcoin.it/wiki/Protocol_specification#version
    parser.word32le('version');
    parser.word64le('services');
    parser.word64le('timestamp');
    parser.buffer('addr_me', 26);
    parser.buffer('addr_you', 26);
    parser.word64le('nonce');
    parser.scan('sub_version_num', new Buffer([0]));
    parser.word32le('start_height');
    break;

  case 'inv':
    Connection.parseVarInt(parser, 'count');

    var invs = [];
    for (var i = 0; i < parser.vars.count; i++) {
      parser.word32le('type');
      parser.buffer('hash', 32);
      invs.push({
        type: parser.vars.type,
        hash: parser.vars.hash
      });
    }

    return {
      command: command,
      count: parser.vars.count,
      invs: invs
    };

  case 'block':
    parser.word32le('version');
    parser.buffer('prev_hash', 32);
    parser.buffer('merkle_root', 32);
    parser.word32le('timestamp');
    parser.word32le('bits');
    parser.word32le('nonce');
    Connection.parseVarInt(parser, 'txn_count');

    var txs = [];
    for (var i = 0; i < parser.vars.txn_count; i++) {
      txs.push(Connection.parseTx(parser));
    }

    return {
      command: command,
      version: parser.vars.version,
      prev_hash: parser.vars.prev_hash,
      merkle_root: parser.vars.merkle_root,
      timestamp: parser.vars.timestamp,
      bits: parser.vars.bits,
      nonce: parser.vars.nonce,
      txs: txs,
      size: payload.length
    };

  case 'tx':
    var txData = Connection.parseTx(parser);
    return {
      command: command,
      version: txData.version,
      lock_time: txData.lock_time,
      ins: txData.ins,
      outs: txData.outs
    };

  case 'getdata':
    Connection.parseVarInt(parser, 'inv_count');

    var invs = [];
    for (var i = 0; i < parser.vars.inv_count; i++) {
      parser.word32le('type');
      parser.buffer('hash', 32);
      invs.push({
        type: parser.vars.type,
        hash: parser.vars.hash
      });
    }
    return {
      command: command,
      invs: invs
    };

  case 'getblocks':
    // TODO: Limit block locator size?
    Connection.parseVarInt(parser, 'start_count');

    var starts = [];
    for (var i = 0; i < parser.vars.start_count; i++) {
      parser.buffer('hash', 32);
      starts.push(parser.vars.hash);
    }
    parser.buffer('stop', 32);
    return {
      command: command,
      version: parser.vars.version,
      starts: starts,
      stop: parser.vars.stop
    };

  case 'addr':
    Connection.parseVarInt(parser, 'addr_count');

    // Enforce a maximum number of addresses per message
    if (parser.vars.addr_count > 1000) {
      parser.vars.addr_count = 1000;
    }

    var addrs = [];
    for (var i = 0; i < parser.vars.addr_count; i++) {
      // TODO: Time actually depends on the version of the other peer (>=31402)
      parser.word32le('time');
      parser.word64le('services');
      parser.buffer('ip', 16);
      parser.word16be('port');
      addrs.push({
        time: parser.vars.time,
        services: parser.vars.services,
        ip: parser.vars.ip,
        port: parser.vars.port
      });
    }
    return {
      command: command,
      addrs: addrs
    };

  case 'getaddr':
    // Empty message, nothing to parse
    break;

  case 'verack':
    // Empty message, nothing to parse
    break;

  case 'ping':
    // Empty message, nothing to parse
    break;

  default:
    logger.error('Connection.parseMessage(): Command not implemented',
                 {cmd: command});

    // This tells the calling function not to issue an event
    return null;
  }

  return parser.vars;
};

Connection.parseVarInt = function (parser, name) {
  // TODO: This function currently only supports reading from buffers, not streams

  parser.word8(name+'_byte');

  switch (parser.vars[name+'_byte']) {
  case 0xFD:
    parser.word16le(name);
    break;

  case 0xFE:
    parser.word32le(name);
    break;

  case 0xFF:
    parser.word64le(name);
    break;

  default:
    parser.vars[name] = parser.vars[name+'_byte'];
  }

  delete parser.vars[name+'_byte'];
};


Connection.parseTx = function (parser) {
  if (Buffer.isBuffer(parser)) {
    parser = Binary.parse(parser);
  }

  parser.word32le('tx_version');
  Connection.parseVarInt(parser, 'tx_in_count');

  var tx_ins = [];
  var j;
  for (j = 0; j < parser.vars.tx_in_count; j++) {
    parser.buffer('tx_in_op', 36);
    Connection.parseVarInt(parser, 'tx_in_script_len');
    parser.buffer('tx_in_script', 'tx_in_script_len');
    parser.word32le('tx_in_seq');
    tx_ins.push({
      o: parser.vars.tx_in_op,
      s: parser.vars.tx_in_script,
      q: parser.vars.tx_in_seq
    });
  }

  Connection.parseVarInt(parser, 'tx_out_count');

  var tx_outs = [];
  for (j = 0; j < parser.vars.tx_out_count; j++) {
    parser.buffer('tx_out_value', 8);
    Connection.parseVarInt(parser, 'tx_out_pk_script_len');
    parser.buffer('tx_out_pk_script', 'tx_out_pk_script_len');

    tx_outs.push({
      v: parser.vars.tx_out_value,
      s: parser.vars.tx_out_pk_script
    });
  }

  parser.word32le('tx_lock_time');

  return {
    version: parser.vars.tx_version,
    lock_time: parser.vars.tx_lock_time,
    ins: tx_ins,
    outs: tx_outs
  };
}
