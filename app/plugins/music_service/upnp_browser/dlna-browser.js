// Copyright 2016 the project authors as listed in the AUTHORS file.
// All rights reserved. Use of this source code is governed by the
// license that can be found in the LICENSE file.
'use strict';
const http = require('http');
const url = require('url');
const xmlbuilder = require('xmlbuilder');
const xmltojs = require('xml2js');
const stripPrefix = require('xml2js').processors.stripPrefix;
const Entities = require('html-entities').XmlEntities;

const entities = new Entities();

var debug = false;

// function to build the xml required for the saop request to the DLNA server
const buildRequestXml = function (id, options) {
  // fill in the defaults
  if (!options.browseFlag) {
    options.browseFlag = 'BrowseDirectChildren';
  }

  if (!options.filter) {
    options.filter = '*';
  }

  if (!options.startIndex) {
    options.startIndex = 0;
  }

  if (!options.requestCount) {
    options.requestCount = 1000;
  }

  if (!options.sort) {
    options.sort = '';
  }

  // build the required xml
  return xmlbuilder.create('s:Envelope', { version: '1.0', encoding: 'utf-8' })
    .att('s:encodingStyle', 'http://schemas.xmlsoap.org/soap/encoding/')
    .att('xmlns:s', 'http://schemas.xmlsoap.org/soap/envelope/')
    .ele('s:Body')
    .ele('u:Browse', { 'xmlns:u': 'urn:schemas-upnp-org:service:ContentDirectory:1'})
    .ele('ObjectID', id)
    .up().ele('BrowseFlag', options.browseFlag)
    .up().ele('Filter', options.filter)
    .up().ele('StartingIndex', options.startIndex)
    .up().ele('RequestedCount', options.requestCount)
    .up().ele('SortCriteria', options.sort)
    .doc().end({ pretty: false, indent: '', allowEmpty: true });
};

// function that allow you to browse a DLNA server
var browseServer = function (id, controlUrl, options, callback) {
  var parser = new xmltojs.Parser({explicitCharKey: true});
  const requestUrl = url.parse(controlUrl);

  var requestXml;
  try {
    requestXml = buildRequestXml(id, options);
  } catch (err) {
    // something must have been wrong with the options specified
    callback(err);
    return;
  }

  const httpOptions = {
    protocol: 'http:',
    host: requestUrl.hostname,
    port: requestUrl.port,
    path: requestUrl.path,
    method: 'POST',
    headers: { 'SOAPACTION': '"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"',
      'Content-Length': Buffer.byteLength(requestXml, 'utf8'),
      'Content-Type': 'text/xml',
      'User-Agent': 'Android UPnP/1.0 DLNADOC/1.50'}
  };

  const req = http.request(httpOptions, function (response) {
    var data = '';
    response.on('data', function (newData) {
      data = data + newData;
    });

    response.on('err', function (err) {
      log(callback(err));
    });

    response.on('end', function () {
      var browseResult = new Object();
      xmltojs.parseString(entities.decode(data), {tagNameProcessors: [stripPrefix], explicitArray: true, explicitCharkey: true}, function (err, result) {
        if (err) {
          log(err);
          // bailout on error
          callback(err);
          return;
        }

        // validate result included the expected entries
        if ((result != undefined) &&
            (result['Envelope']) &&
            (result['Envelope']['Body']) &&
            (result['Envelope']['Body'][0]) &&
            (result['Envelope']['Body'][0]['BrowseResponse']) &&
            (result['Envelope']['Body'][0]['BrowseResponse'][0]) &&
            (result['Envelope']['Body'][0]['BrowseResponse'][0]['Result']) &&
            (result['Envelope']['Body'][0]['BrowseResponse'][0]['Result'][0])
        ) {
          var listResult = result['Envelope']['Body'][0]['BrowseResponse'][0]['Result'][0];
          // this likely needs to be generalized to acount for the arrays. I don't have
          // a server that I've seen return more than one entry in the array, but I assume
          // the standard allows for that.  Will update when I have a server that I can
          // test that with

          if (listResult['DIDL-Lite']) {
            const content = listResult['DIDL-Lite'][0];
            if (content.container) {
              browseResult.container = new Array();
              for (let i = 0; i < content.container.length; i++) {
                browseResult.container[i] = parseContainer(content.container[i]);
              }
            }

            if (content.item) {
              browseResult.item = new Array();
              for (let i = 0; i < content.item.length; i++) {
                // hide the item if we cannot play
                let parsedItem = parseItem(content.item[i]);
                if (parsedItem)
                  browseResult.item.push(parsedItem)
              }
            }
            callback(undefined, browseResult);
          } else {
            callback(new Error('Did not get expected listResult from server:' + result));
          }
        } else {
          if (result != undefined) {
            callback(new Error('Did not get expected response from server:' + JSON.stringify(result)));
          } else {
            callback(new Error('Did not get any response from server:'));
          }
        }
      });
    });
  });
  req.on('error', function (err) {
    callback(err);
    req.abort();
  });
  req.write(requestXml);
  req.end();
};

function parseContainer (metadata) {
  var container = {
    'class': '',
    'title': '',
    'id': '',
    'parentId': '',
    'children': ''
  };
  try {
    if (metadata) {
      if (metadata.title) {
        container.title = metadata.title[0]['_'];
      }
      if (metadata.artist) {
        container.artist = metadata.artist[0]['_'];
      }
      if (metadata.class) {
        container.class = metadata.class[0]['_'];
      }
      if (metadata['$']) {
        if (metadata['$'].id) {
          container.id = metadata['$'].id;
        }
        if (metadata['$'].parentID) {
          container.parentId = metadata['$'].parentID;
        }
        if (metadata['$'].childCount) {
          container.children = metadata['$'].childCount;
        }
      }
    }
  } catch (e) {
    log(e);
  }
  return container;
}

function chooseBestStreamIdx (resArray) {
  const MaxSampFreq = 192000;
  const MaxBitDepth = 32; // because it alsa can play it at 24-bit
  const MaxNrChns = 2;
  let bstIdx = -1; // nothing chosen yet

  if (resArray) {
    resArray.forEach((res, idx, arr) => {
      let thisFreq = (res['$'].sampleFrequency === undefined)? Number.MAX_SAFE_INTEGER : Number(res['$'].sampleFrequency);
      // bitsPerSample not always available - perhaps there is some kind of implicit default?
      // only uses it if this is the only stream, and all the other properties qualifies.
      let thisBitsPerSample;
      if (res['$'].bitsPerSample === undefined) {
        console.log(`Warning: undefined bitsPerSample field.`);
      }
      else {
        thisBitsPerSample = Number(res['$'].bitsPerSample);
      }
      let thisNrChns = (res['$'].nrAudioChannels === undefined)? Number.MAX_SAFE_INTEGER : Number(res['$'].nrAudioChannels);
      if (debug) console.log(`Entering: idx=${idx}:  ${thisFreq} / ${thisBitsPerSample} / ${thisNrChns}`);
      // qualifies (let thisBitsPerSample===undefined qualifies)
      if (thisFreq <= MaxSampFreq && (thisBitsPerSample === undefined || thisBitsPerSample <= MaxBitDepth) 
          && thisNrChns <= MaxNrChns) {
        if (bstIdx >= 0) {
          let bstFreq = Number(arr[bstIdx]['$'].sampleFrequency);
          let bstBitsPerSample = Number(arr[bstIdx]['$'].bitsPerSample);
          let bstNrChns = Number(arr[bstIdx]['$'].nrAudioChannels);
          // Do not replace existing choice if this bitsPerSample is undefined while
          // bitsPerSample of currently chosen stream is defined.
          if (thisBitsPerSample !== undefined || bstBitsPerSample === undefined) {
            if (thisFreq > bstFreq) {
              if (debug) console.log(`${thisFreq} > ${bstFreq}`);
              bstIdx = idx;
            }
            else if (thisFreq === bstFreq) {
              if (thisNrChns > bstNrChns) {
                if (debug) console.log(`${thisNrChns} > ${bstNrChns}`);
                bstIdx = idx;
              }
              else if (thisNrChns === bstNrChns) {
                if (thisBitsPerSample !== undefined) {
                  if (bstBitsPerSample === undefined) {
                    if (debug) console.log(`${bstBitsPerSample} better than  ${bstBitsPerSample}`);
                    bstIdx = idx;
                  }
                  else {
                    if (thisBitsPerSample > bstBitsPerSample) {
                      if (debug) console.log(`${thisBitsPerSample} > ${bstBitsPerSample}`);
                      bstIdx = idx;
                    }
                  }
                }
              }
            }
          }
        }
        else {
          // this should be the only place where undefined bitsPerSample will be chosen
          bstIdx = idx;
        }
      }
      if (debug) console.log(`bstIdx after idx=${idx}:  ${bstIdx}`);
    });
  }
  return bstIdx;
}

function parseItem (metadata) {
  let item = null;
  try {
    item = {
      'class': '',
      'id': '',
      'title': '',
      'artist': '',
      'album': '',
      'parentId': '',
      'duration': '',
      'source': '',
      'image': ''};
    if (metadata) {
      if (metadata.class) {
        item.class = metadata.class[0]['_'];
      }
      if (metadata.title) {
        item.title = metadata.title[0]['_'];
      }
      if (metadata.artist) {
        item.artist = metadata.artist[0]['_'];
      }
      if (metadata.album) {
        item.album = metadata.album[0]['_'];
      }
      if (metadata.res) {
        if (debug) console.log(`res length: ${metadata.res.length} for title ${item.title}`);
        let bestResIdx = chooseBestStreamIdx(metadata.res);
        if (bestResIdx < 0) {
          throw new Error(`Warning: Unable to choose best stream format for ${item.title} - return null!`);
        }
        else {
          console.log(`Chosen res idx ${bestResIdx} out of ${metadata.res.length} for ${item.title}`);
        }
        item.source = metadata.res[bestResIdx]['_'];
        console.log(`${item.title} source: ${item.source} `);
        console.log(`${item.title} audio format: ${metadata.res[bestResIdx]['$'].sampleFrequency}Hz,  ${metadata.res[bestResIdx]['$'].bitsPerSample} bits,  ${metadata.res[bestResIdx]['$'].nrAudioChannels} channels  `);
        if (metadata.res[bestResIdx]['$'].duration) {
          var dur = metadata.res[bestResIdx]['$'].duration;
          var time = dur.split(':');
          item.duration = parseInt(parseFloat(time[0]) * 3600 + parseFloat(time[1]) * 60 + parseFloat(time[2]));
        }
      }
      if (metadata.albumArtURI) {
        item.image = metadata.albumArtURI[0]['_'];
      }
      if (metadata['$']) {
        if (metadata['$'].id) {
          item.id = metadata['$'].id;
        }
        if (metadata['$'].parentID) {
          item.parentId = metadata['$'].parentID;
        }
      }
    }
  }
  catch(err) {
    console.log(`Error caught in dlna-browser parseItem(). ${err}`);
    item = null;
  }
  
  return item;
}

function log (message) {
  if (debug) {
    console.log(message);
  }
}

module.exports = browseServer;
