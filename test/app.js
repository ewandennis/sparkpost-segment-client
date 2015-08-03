var chai = require('chai');
var sinon = require('sinon');
var sinonChai = require('sinon-chai');

var expect = chai.expect;
chai.config.includeStack = true;

var apputils = require('../lib/app').utils;

var testevents = require('../testevents.json');

describe('applib', function() {
	describe('#unpackSPEvent', function () {
		it('should strip msys and *_event wrappers', function (done) {
			var rawevt = testevents[0];
			var unpacked = apputils.unpackSPEvent(rawevt);
			expect(unpacked).to.deep.equal(rawevt.msys.message_event);
			done();
		});
	});

	describe('#filterInterestingSPEvents', function () {
		it('should pass only SP_EVENT_TYPES and SP_FBEVENT_TYPES events', function (done) {

			var spy = sinon.spy(apputils, 'filterInterestingSPEvents');

			var evt = {
				msys: {
					message_event: {
					}
				}
			};

			apputils.SP_EVENT_TYPES.forEach(function (evttype) {
				evt.msys.message_event.type = evttype;
				if (evttype == 'feedback') {
					apputils.SP_FBEVENT_TYPES.forEach(function (fbevttype) {
						evt.msys.message_event.fbtype = fbevttype;
						apputils.filterInterestingSPEvents(evt);
						expect(spy.returnValues[0]).to.be.ok;
						spy.reset();
					});
				} else {
					apputils.filterInterestingSPEvents(evt);
					expect(spy.returnValues[0]).to.be.ok;
					spy.reset();
				}
			});

			evt.msys.message_event.type = '?FEEDB00F!';
			apputils.filterInterestingSPEvents(evt);
			expect(spy.returnValues[0]).to.not.be.ok;
			spy.reset();

			evt.msys.message_event.fbtype = '?F00DBEEF!';
			apputils.filterInterestingSPEvents(evt);
			expect(spy.returnValues[0]).to.not.be.ok;

			done();
		});
	})

	describe('#augmentSPEvents', function () {
		it('should add rcpt_to, rcpt_meta and tags fields to events based on their message_ids');
	});

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

			var result = apputils.formatSPMetadataForSegment(inevt);
			expect(result).to.deep.equal(out);
			done();
		});
	});

	describe('#sendTrackEventsToSegment', function () {
		it('should call segment.track for each given event');
	});

	describe('#mkMessageIdMap', function () {
		it('should create a msgid -> email map from given events', function (done) {
			var inevents = [
				{
					rcpt_to: 'jim@jiminy.com',
					rcpt_meta: {
						'food': 'ice cream',
						'funds': 'negligable'
					},
					tags: ['vanilla', 'low value'],
					message_id: '111-1111-11111111-11111-111'
				},
				{
					rcpt_to: 'bob@bobby.com',
					rcpt_meta: {
						'food': 'muffins',
						'funds': 'copious'
					},
					tags: ['choc chip', 'premium'],
					message_id: '222-2222-22222222-22222-222'
				}
			];

			var expectation = {};
			expectation[inevents[0].message_id] = {
				rcpt_to: inevents[0].rcpt_to,
				rcpt_meta: inevents[0].rcpt_meta,
				tags: inevents[0].tags
			};
			expectation[inevents[1].message_id] = {
				rcpt_to: inevents[1].rcpt_to,
				rcpt_meta: inevents[1].rcpt_meta,
				tags: inevents[1].tags
			}

			var msgidmap = apputils.mkMessageIdMap(inevents);
			expect(msgidmap).to.deep.equal(expectation);
			done();
		});
	});
});
