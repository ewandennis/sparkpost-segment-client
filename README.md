# SparkPost.com To Segment.com Integration

[SparkPost.com](https://www.sparkpost.com/) offers a [webhook facility](https://www.sparkpost.com/api#/reference/webhooks) to share email delivery and engagement events.

[Segment.com](https://segment.com/) accepts tracking events and exposes them to its suite of integrations.

This package feeds SparkPost webhook events into Segment.com.

### Prerequisites

This package requires:

* a [SparkPost account](https://app.sparkpost.com/sign-up)
* a [Segment account](https://segment.com/signup)
* a place to host a public-facing Node.JS-based HTTP service

### How It Works

This package is a SparkPost webhooks endpoint - an HTTP service which receives batches of email tracking events from SparkPost.  It translates the events it receives into Segment.com tracking events which can then be fed into Segment's various integrations.  The [Event Mapping][mapping] section describes how that translation takes place.

### Setup

Grab the code:

```
git clone https://github.com/ewandennis/sparkpost-segment-client.git
npm install
```

Edit config/default.json and set ```segmentAPI.key``` to a [Segment.com write API key](https://segment.com/docs/libraries/http/#authentication).  See the [Configuration section][config] below for more config details.

Start it up:

```
npm run prod
```

You now have a SparkPost webhook endpoint at ```http://YOUR_HOST:3000/api/v1/events```.

Finally, register your endpoint with a webhook on your SparkPost account.

Now, when you send emails through SparkPost, you can track them in Segment.  See the [Event Mapping][mapping] section below for details on which events are imported with with what fields.

[mapping]
### SparkPost -> Segment Event Mapping

SparkPost events are translated into Segment events with this mapping:

SparkPost Event Type | Segment Event Type | Segment Event Name
--------------------:|:------------------:|:------------------
delivery             | track              | Email Delivered
bounce               | track              | Email Bounced
out_of_band          | track              | Email Bounced
feedback             | track              | Email Marked as Spam
open                 | track              | Email Opened
click                | track              | Email Clicked

In addition to the above, the first time this package receives an event for a new message, it emits an ```identify``` event to Segment.

Segment events are populated with SparkPost event fields like this:

Segment Field | SparkPost Field(s)
-------------:|:------------------
userId        | rcpt_to
traits        | rcpt_meta, tags

[config]
### Configuration

The package's configuration is held in config/*.json and uses the [config](https://github.com/lorenwest/node-config) Node.js module.  We use the following config fields:

* _app_
  * _port_: TCP port the SparkPost webhook endpoint listens on (numeric)
  * _maxJSONPayloadSize_: how much JSON can we eat? (using [bytes](https://www.npmjs.com/package/bytes) notation)
* _logging_
  * _level_: log volume ("debug"|"info"|"warn"|"error")
* _segmentAPI_
  * _key_: your Segment project write key (string)
  * _opts_: [Segment Node.js client options](https://segment.com/docs/libraries/node/quickstart/)
* _legacyMode_: accept legacy or modern style SparkPost events (boolean)
* _sparkPost_: internal SparkPost to Segment event mapping info
* _sparkPostLegacy_: internal SparkPost to Segment event mapping info

