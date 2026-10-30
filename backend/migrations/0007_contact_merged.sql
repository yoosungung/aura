ALTER TABLE contacts
    ADD COLUMN merged_into_contact_id UUID REFERENCES contacts(id);
