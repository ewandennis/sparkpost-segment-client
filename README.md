# SparkPost.com To Segment.com Integration

SparkPost.com offers a webhooks facility to share email delivery and engagement events.

Segment.com accepts tracking events and exposes them to its suite of integrations.

This package feeds SparkPost webhook events into Segment.com.

### Prerequisites

This package requires:

* a [SparkPost account](https://app.sparkpost.com/sign-up)
* a [Segment account](https://segment.com/signup)
* a place to host a public-facing Node.JS-based HTTP service

### How It Works

This package presents a SparkPost webhooks endpoint, an HTTP service which receives batches of email tracking events from SparkPost.  It translates the events it receives into Segment.com tracking events which can then be fed into Segment's various integrations.

### Setup

Grab the code:

  git clone https://github.com/ewandennis/sparkpost-segment-client.git
  npm install

Edit config/default.json and set segmentAPI.key to a Segment.com write API key.  See the Configuration section below for more config details.

Start it up:

  npm run prod

You now have a SparkPost webhook endpoint at ```http://YOUR_HOST:3000/api/v1/events```.

Finally, register your endpoint with a webhook on your SparkPost account.

Now, when you send emails through SparkPost, you can track them in Segment.  See the Event Mapping section below for details on which events are imported with with what fields.

### SparkPost -> Segment Event Mapping

SparkPost Event Type | Segment Event Type | Segment Event Name
--------------------:|:------------------:|:------------------
delivery             | track              | Email Delivered
bounce               | track              | Email Bounced
out_of_band          | track              | Email Bounced
feedback             | track              | Email Marked as Spam
open                 | track              | Email Opened
click                | track              | Email Clicked
