var chai = require('chai');
var sinon = require('sinon');
var sinonChai = require('sinon-chai');
var config = require('config');

var expect = chai.expect;
chai.config.includeStack = true;

var SPEventFilter = require('../lib/spevents');

beforeEach('Initialise SPEventFilter instance', function () {
	var legacyMode = config.get('legacyMode');
	var spConfigKey = legacyMode ? 'sparkPostLegacy' : 'sparkPost';
	this.spConfig = config.get(spConfigKey);
	this.spevents = new SPEventFilter(this.spConfig);

	this.testevents = require( legacyMode ? './testevents1.json' : './testevents1-4.2.json');
});

describe('spevents', function() {
	describe('#unpackEvent', function () {
		it('should strip msys and *_event wrappers', function (done) {
			var self = this;
			var rawevt = self.testevents[0];
			var unpacked = self.spevents.unpackEvent(rawevt);
			expect(unpacked).to.deep.equal(rawevt.msys.message_event);
			done();
		});
	});

	describe('#eventIsInteresting', function () {
		it('should pass only SP_EVENT_TYPES and SP_FBEVENT_TYPES events', function (done) {
			var self = this;

			var evt = {
				msys: {
					message_event: {
					}
				}
			};

			self.spConfig.eventTypes.forEach(function (evttype) {
				evt.msys.message_event.type = evttype;
				if (evttype == 'feedback') {
					self.config.fbEventTypes.forEach(function (fbevttype) {
						evt.msys.message_event.fbtype = fbevttype;
						expect(self.spevents.eventIsInteresting(evt)).to.be.ok;
					});
				} else {
					expect(self.spevents.eventIsInteresting(evt)).to.be.ok;
				}
			});

			evt.msys.message_event.type = '?FEEDB00F!';
			expect(self.spevents.eventIsInteresting(evt)).to.not.be.ok;

			evt.msys.message_event.fbtype = '?F00DBEEF!';
			expect(self.spevents.eventIsInteresting(evt)).to.not.be.ok;

			done();
		});
	})

	describe('#formatSPMetadataForSegment', function () {
		it('should merge rcpt_to, rcpt_mta and tags fields into a segment traits dictionary', function (done) {
			var inevt = {
				rcpt_to: 'jim@jiminy.com',
				rcpt_meta: {
					first_name: 'Jim',
					surname: 'Jiminy'
				},
				tags: ['male', 'fictitious']
			};
			var out = {
				email: 'jim@jiminy.com',
				first_name: 'Jim',
				surname: 'Jiminy',
				tags: ['male', 'fictitious']
			};

			var result = this.spevents.formatSPMetadataForSegment(inevt);
			expect(result).to.deep.equal(out);
			done();
		});
	});
});
