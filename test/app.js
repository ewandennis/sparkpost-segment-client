var chai = require('chai');
var sinon = require('sinon');
var sinonChai = require('sinon-chai');

var expect = chai.expect;
chai.config.includeStack = true;

var appLib = require('../lib/app');

var testevents = require('../testevents.json');

before('Load app config', function() {
	appLib.loadConfig();
})

describe('applib', function() {
	describe('#unpackEvent', function () {
		it('should strip msys and *_event wrappers', function (done) {
			var rawevt = testevents[0];
			var unpacked = appLib.utils.unpackEvent(rawevt);
			expect(unpacked).to.deep.equal(rawevt.msys.message_event);
			done();
		});
	});

	describe('#eventIsInteresting', function () {
		it('should pass only SP_EVENT_TYPES and SP_FBEVENT_TYPES events', function (done) {

			var spy = sinon.spy(appLib.utils, 'eventIsInteresting');

			var evt = {
				msys: {
					message_event: {
					}
				}
			};

			appLib.utils.SP_EVENT_TYPES.forEach(function (evttype) {
				evt.msys.message_event.type = evttype;
				if (evttype == 'feedback') {
					appLib.utils.SP_FBEVENT_TYPES.forEach(function (fbevttype) {
						evt.msys.message_event.fbtype = fbevttype;
						appLib.utils.eventIsInteresting(evt);
						expect(spy.returnValues[0]).to.be.ok;
						spy.reset();
					});
				} else {
					appLib.utils.eventIsInteresting(evt);
					expect(spy.returnValues[0]).to.be.ok;
					spy.reset();
				}
			});

			evt.msys.message_event.type = '?FEEDB00F!';
			appLib.utils.eventIsInteresting(evt);
			expect(spy.returnValues[0]).to.not.be.ok;
			spy.reset();

			evt.msys.message_event.fbtype = '?F00DBEEF!';
			appLib.utils.eventIsInteresting(evt);
			expect(spy.returnValues[0]).to.not.be.ok;

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

			var result = appLib.utils.formatSPMetadataForSegment(inevt);
			expect(result).to.deep.equal(out);
			done();
		});
	});
});
