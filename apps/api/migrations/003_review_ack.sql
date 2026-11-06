-- CR-004 (World): the employee's World ID acknowledgement of a review.
ALTER TABLE reviews ADD COLUMN ack_json TEXT;
