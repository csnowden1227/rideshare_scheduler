# CRM_One_Source Booking Workflow

This document defines the standard booking workflow for the `rideshare-scheduler` app and the exact CRM_One_Source automation pattern to use with the inbound webhook.

## Goal

The app should:

1. Collect trip details in the booking widget.
2. Calculate pricing.
3. Check availability before confirming the ride.
4. Take payment immediately.
5. Create the booking only after successful payment.
6. Send a standardized booking event to CRM_One_Source.
7. Let CRM_One_Source handle confirmations, reminders, internal notifications, and follow-up automation.

## Standard Booking Sequence

1. Customer enters:
- first name
- last name
- email
- phone
- pickup address
- dropoff address
- pickup date/time
- vehicle selection
- event selection
- luggage
- add-ons

2. Widget calculates:
- quoted ride price
- add-on total
- tax
- deposit due
- total due now

3. App checks:
- pickup is inside configured service area
- fixed-rate zone override
- peak multiplier
- event pricing override
- calendar availability

4. App processes payment.

5. If payment succeeds:
- booking is inserted into the database
- selected vehicle slot is used
- calendar event is written
- CRM webhook is fired with `BOOKING_CONFIRMED`

6. CRM_One_Source automation runs.

## Recommended Status Model

Use these statuses in CRM and backend:

- `quote_ready`
- `availability_verified`
- `payment_pending`
- `confirmed`
- `completed`
- `cancelled`
- `payment_failed`
- `waitlist`

For the current live booking flow, the webhook event being sent is:

- `webhook_bookings`

## Inbound Webhook Event Shape

The backend now sends a standardized payload in this shape:

```json
{
  "webhook_type": "webhook_bookings",
  "location_id": "LOCATION_ID",
  "business_name": "Business Name",
  "source": "booking_widget",
  "created_at": "2026-03-31T20:00:00.000Z",
  "booking_confirmed": true,
  "payment_follow_up_required": false,
  "booking": {
    "booking_id": 12345,
    "status": "confirmed",
    "pickup_address": "123 Main St",
    "dropoff_address": "LAX Terminal 4",
    "pickup_lat": 34.05,
    "pickup_lng": -118.24,
    "dropoff_lat": 33.94,
    "dropoff_lng": -118.40,
    "start_time": "2026-04-02T15:00:00.000Z",
    "end_time": "2026-04-02T16:45:00.000Z",
    "passenger_count": 2,
    "carry_on_count": 1,
    "checked_bag_count": 2,
    "additional_items_aboard": "{\"preset\":\"Car Seat\",\"custom\":\"\"}",
    "selected_event_name": "",
    "selected_addons": ["addon_0", "addon_2"]
  },
  "customer": {
    "first_name": "Christina",
    "last_name": "Snowden",
    "email": "customer@example.com",
    "phone": "+13105551212"
  },
  "vehicle": {
    "vehicle_slot_id": "VXE0UY17p7wnxdZ3sOLc_vehicle_1",
    "vehicle_type": "Luxury SUV",
    "vehicle_category": null,
    "calendar_id": "primary"
  },
  "financials": {
    "quoted_price": 185,
    "addon_total": 25,
    "tax_amount": 17.33,
    "total_price": 227.33,
    "deposit_percent": 25,
    "deposit_amount": 56.83,
    "balance_due": 170.5,
    "payment_status": "paid_deposit",
    "payment_paid": true,
    "deposit_paid": true,
    "balance_paid": false,
    "payment_required": false,
    "payment_link": null
  },
  "follow_up": {
    "send_payment_sms": false,
    "send_payment_email": false,
    "reminder_reason": null
  }
}
```

## CRM_One_Source Workflow Blueprint

Build a workflow named:

- `Rideshare Booking - Confirmed`

Trigger:

- inbound webhook received

Filter:

- `webhook_type` equals `webhook_bookings`

## CRM Field Mapping

Create or verify these custom fields in CRM_One_Source.

Contact fields:

- `booking_id`
- `booking_status`
- `pickup_address`
- `dropoff_address`
- `pickup_time`
- `dropoff_time`
- `vehicle_type`
- `vehicle_slot_id`
- `calendar_id`
- `passenger_count`
- `carry_on_count`
- `checked_bag_count`
- `additional_items_aboard`
- `selected_event_name`
- `selected_addons`
- `quoted_price`
- `addon_total`
- `tax_amount`
- `total_price`
- `deposit_percent`
- `deposit_amount`
- `balance_due`
- `payment_status`
- `payment_paid`
- `deposit_paid`
- `balance_paid`
- `booking_confirmed`
- `payment_follow_up_required`
- `location_id`
- `booking_source`

Recommended tags:

- `rideshare-booking`
- `booking-confirmed`
- `payment-paid-in-full` or `payment-paid-deposit`
- vehicle tag like `vehicle-luxury-suv`
- location tag like `location-VXE0UY17p7wnxdZ3sOLc`

## CRM Pipeline

Pipeline:

- `Rideshare Bookings`

Stages:

- `New Booking`
- `Payment Confirmed`
- `Scheduled`
- `En Route`
- `Completed`
- `Cancelled`
- `No Show`

For the current booking event, place new opportunities into:

- `Scheduled`

## Workflow Steps

1. Receive webhook
- trigger on inbound webhook
- filter to `webhook_bookings`

2. Find or create contact
- match by `customer.email`
- fallback to `customer.phone`

3. Update contact fields
- map each payload field into CRM custom fields
- store all booking and financial details

4. Create or update opportunity
- pipeline: `Rideshare Bookings`
- stage: `Scheduled`
- opportunity name format:
  `{{customer.first_name}} {{customer.last_name}} - {{booking.start_time}} - {{vehicle.vehicle_type}}`

5. Apply tags
- `rideshare-booking`
- `booking-confirmed`
- `payment_status` based tag
- event tag if `selected_event_name` exists

6. Create note on contact or opportunity
- include:
  - pickup and dropoff
  - scheduled start
  - vehicle type
  - booking id
  - total price
  - deposit amount
  - balance due
  - add-ons

7. Send customer confirmation SMS
- confirm booking received
- include pickup time
- include pickup and dropoff summary
- include support phone number

8. Send confirmation email
- booking summary
- payment summary
- cancellation or support instructions

9. Send internal notification
- notify dispatcher/team
- include booking id, route, time, vehicle, payment status

10. Schedule reminders
- 24 hours before pickup
- 2 hours before pickup

11. Optional follow-up workflows
- `BOOKING_CANCELLED`
- `PAYMENT_FAILED`
- `BALANCE_DUE`
- `BOOKING_COMPLETED`

12. Unconfirmed payment follow-up
- if `booking_confirmed = false`
- if `payment_follow_up_required = true`
- send quote SMS
- send quote email
- include `financials.total_price`
- include `financials.deposit_amount`
- include `financials.payment_link` when available
- use `follow_up.send_payment_sms` and `follow_up.send_payment_email` as CRM conditions if helpful

## Recommended Additional Webhook Events

As the platform matures, add these event types:

- `BOOKING_CANCELLED`
- `BOOKING_COMPLETED`
- `PAYMENT_FAILED`
- `PAYMENT_CAPTURED`
- `BALANCE_DUE`
- `DRIVER_EN_ROUTE`
- `DRIVER_ARRIVED`

Each should trigger its own smaller CRM workflow instead of one giant automation.

## Immediate Payment Rule

Standard rideshare or chauffeur behavior should be:

1. check availability
2. take payment immediately
3. create booking only after payment succeeds
4. send `webhook_bookings` webhook
5. send confirmations and reminders from CRM

If payment fails:

- do not confirm the booking
- do not write the final appointment to the live calendar
- optionally trigger `PAYMENT_FAILED`

## API + Webhook Configuration Notes

Store CRM credentials in environment variables rather than hardcoding them.

Recommended environment variables:

- `CRMONESOURCE_API_KEY`
- `CRM_WEBHOOK_URL`

Do not commit secrets directly into source files.

## Project Notes

Current implementation status:

- widget sends enriched booking pricing details
- server sends standardized `webhook_bookings` payload
- booking lookup uses `vehicle_slot_id`
- CRM should consume the inbound webhook and build the customer lifecycle from it

## Suggested Next Build Step

Implement server-side availability hold + payment confirmation sequence:

1. `POST /api/availability-check`
2. `POST /api/payment-intent`
3. `POST /api/confirm-booking`

That will fully enforce:

- availability before payment
- payment before booking confirmation
- CRM capture only after confirmation
