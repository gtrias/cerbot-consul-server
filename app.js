var _                = require('underscore');
var config           = require('config');
var LE               = require('greenlock');
var express          = require('express');
var consulHost       = config.get('consul.host');
var async            = require('async');
var concat           = require('concat-files');
var fs               = require('fs');
var winston          = require('winston');
var debug            = config.get('letsencrypt.debug');
var consul           = require('consul')({
    host: consulHost
});

var logger = new (winston.Logger)({
  transports: [
    new (winston.transports.Console)({timestamp : true})
  ]
});

// Storage Backend
var leStore = require('le-store-certbot').create({
  configDir: config.get('letsencrypt.configDir'),  // or /etc/letsencrypt or wherever
  debug: debug
});


// ACME Challenge Handlers
var leChallenge = require('le-challenge-fs').create({
  webrootPath: config.get('letsencrypt.webrootPath'),     // or template string such as
  debug: debug
});


function leAgree(opts, agreeCb) {
  // opts = { email, domains, tosUrl }
  agreeCb(null, opts.tosUrl);
}

var server = LE.stagingServerUrl;

if (config.get('letsencrypt.server') === 'production') {
  server = LE.productionServerUrl;
}

le = LE.create({
  server: server,                                          // or LE.productionServerUrl
  store: leStore,                                          // handles saving of config, accounts, and certificates
  challenges: { 'http-01': leChallenge },                  // handles /.well-known/acme-challege keys and tokens
  challengeType: 'http-01',                                // default to this challenge type
  loopbackPort: config.get('letsencrypt.loopbackPort'),
  agreeToTerms: leAgree,                                   // hook to allow user to view and accept LE TOS
  debug: debug
});

// Getting consul agent nodename to start watcher
function startListen() {
  consul.agent.self(function(err, result) {
    if (err) {
      startListen();
    } else {
      startWatcher(result);
    }
  });
}
// First execution
startListen();

// Starting watcher
function startWatcher(node) {
  var nodeName = node.Config.NodeName;
  var watch = consul.watch({ method: consul.catalog.service.list, options: {'node': nodeName}});

  watch.on('change', function(data, res) {
    var services = [];

    async.forEachOf(data, function(service, key, callback) {
      consul.catalog.service.nodes(key, function(err, result) {
        if (err) throw err;

        services.push({
          ID: key,
          nodes: result
        });

        callback();
      });
    }, function (err) {
      if (err) return logger.error(err);

      requestCertificates(services);
    });

  });

  watch.on('error', function(err) {
    logger.error('error:', err);
  });
}

function registerCertificate(virtualHosts, email) {

  // Register Certificate manually
  le.register({
    domains:  virtualHosts,   // CHANGE TO YOUR DOMAIN (list for SANS)
    email: email,
    agreeTos:  true,           // set to tosUrl string (or true) to pre-approve (and skip agreeToTerms)
    rsaKeySize: 2048,          // 2048 or higher
    challengeType: 'http-01'   // http-01, tls-sni-01, or dns-01
  }).then(function (results) {
    logger.info('[Success]: Successfull generated the next certificate: %j', results);

    concatFiles(virtualHosts, function (err) {
      if (err) {
        logger.error('[Error] Failed to concate files, err %j', err);
      } else {
        logger.info('[Success] files concated succesfully');
      }
    });


  }, function (err) {
    // Note: you must either use le.middleware() with express,
    // manually use le.challenges['http-01'].get(opts, domain, key, val, done)
    // or have a webserver running and responding
    // to /.well-known/acme-challenge at `webrootPath`

    logger.error('[Error]: Error registering certificate %j %j', virtualHosts, err);
  });
}

function requestCertificates(data) {
  var configurationPairs = extractDomainEmailPairs(data);

  for (var i = 0; i < configurationPairs.length; i++) {
    var virtualHost = configurationPairs[i].SSL_VIRTUAL_HOST;
    var email = configurationPairs[i].SSL_EMAIL;

    // Check in-memory cache of certificates for the named domain
    le.check({ domains: virtualHost }).then(
      registerCertificate(virtualHost, email)
    );
  }
}

function concatFiles(virtualHost, cb) {
  var certPath = config.get('letsencrypt.configDir') + '/live/' + virtualHost[0] + '/fullchain.pem';
  var privPath = config.get('letsencrypt.configDir') + '/live/' + virtualHost[0] + '/privkey.pem';
  console.log(certPath);
  console.log(privPath);
  if(fs.existsSync(certPath) && fs.existsSync(privPath) ) {
    var dest = config.get('letsencrypt.configDir') + '/live/' + virtualHost[0] + '/' + virtualHost[0] + '.pem';
    concat([
      certPath,
      privPath
    ], dest, function (err) {
      if (err) return cb(err);

      logger.info("cert and priv successfully concated");

      return cb(null);
    });
  } else {
    cb({error: "The generated certificates cannot be found"});
  }
}

/**
 * Convert services payload to key-value pairs with SSL_VIRTUAL_HOST and SSL_EMAIL
 */
function extractDomainEmailPairs(data) {

  // Hacky way to get object array
  var result = [];

  data.forEach(function (element) {

    element.nodes.forEach(function (node) {
      var pair = [];
      pair.SSL_VIRTUAL_HOST = [];

      if (node.ServiceTags) {

        for (var j = 0; j < node.ServiceTags.length; j++) {
          var kV = node.ServiceTags[j].split('=');


          if (kV[0] && kV[0] === 'SSL_VIRTUAL_HOST'){
            pair.SSL_VIRTUAL_HOST.push( kV[1]);
          }
          if (kV[0] && kV[0] === 'SSL_EMAIL'){
            pair.SSL_EMAIL = kV[1];
          }
        }

        if (pair.SSL_VIRTUAL_HOST.length && pair.SSL_EMAIL) {
          result.push(pair);
        }
      }
    });

  });

  return result;
}

// Configuring express.js to manage .well-known requests
var app = express();
app.use('/', le.middleware());

var port = 54321;
app.listen(port, function () {
  logger.info('Example app listening on port %s!', port);
});
