var chai = require('chai');
var supertest = require('supertest');
var sinon = require('sinon');
var request = require('request');
var appLib = require('../lib/app.js');
var segment = require('analytics-node');

var TEST_EVENTS = require('../testevents.json');

chai.should();

function makeSegmentStub() {
  return {
      identify: sinon.spy(),
      track: sinon.spy(),
      flush: sinon.spy()
    };
}

describe('SparkPost webhook endpoint', function () {
  it('accepts JSON POST requests', function (done) {
    var segmentStub = makeSegmentStub();
    var app = new appLib(segmentStub);

    supertest(app)
      .post('/inbound')
      .set('Content-type', 'application/json')
      .expect(200, done)
  });
});

var server;

function startServer (app, next) {
  server = app.listen(3000, next);
}

function stopServer() {
  server.close();
}

function testResponseToEventType(evtType, next) {
  var events = TEST_EVENTS.filter(function (elt) {
    return elt.msys.message_event && elt.msys.message_event.type == evtType;
  });

  request({
    uri: 'http://localhost:3000/inbound',
    method: 'POST',
    json: events
  }).on('response', next);
}

describe('Segment.com client', function () {
  var segmentStub = makeSegmentStub();
  var app = new appLib(segmentStub);

  before(function (done) {
    startServer(app, done);
  });

  after(function() {
    stopServer();
  });

  it('makes 1 segment.identify call per inbound email address', function (done) {
    testResponseToEventType('delivery', function(resp) {
      chai.assert(segmentStub.identify.calledOnce, 'Segment.identify called once');
      app.flushSegmentCache();
      done();
    });
  });

  ['delivery', 'bounce', 'out_of_band', 'feedback', 'click', 'open'].forEach(function (eventType) {
    it('makes 1 segment.track call for each received ' + eventType + ' event', function (done) {
      testResponseToEventType(eventType, function(resp) {
        chai.assert(segmentStub.track.calledOnce, 'Segment.track called once after inbound ' + eventType + ' event');
        app.flushSegmentCache();
        done();
      });
    });
  });
});
