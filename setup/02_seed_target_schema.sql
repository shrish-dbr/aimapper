-- Seed the target schema with a sample healthcare model: member, provider,
-- enrollment, claim, claim_line, pharmacy_claim, prior_authorization.
-- Idempotent: clears existing rows for these tables before inserting.
--
-- Normally run by the installer (python3 setup/install.py install). To run by
-- hand instead, replace `your_catalog` below with your catalog name.
USE CATALOG your_catalog;
USE SCHEMA aimapper;

DELETE FROM target_schema
WHERE target_table IN ('member', 'provider', 'enrollment', 'claim', 'claim_line', 'pharmacy_claim', 'prior_authorization');

INSERT INTO target_schema
  (target_table, target_column, ordinal_position, data_type, data_length, numeric_precision, numeric_scale, is_nullable, is_primary_key, description, transform_hint)
VALUES
  -- ===================== MEMBER =====================
  ('member', 'member_id',        1,  'STRING', 20,   NULL, NULL, false, true,  'Unique member identifier',                 'Zero-pad / trim to canonical id; never NULL'),
  ('member', 'first_name',       2,  'STRING', 50,   NULL, NULL, true,  false, 'Member legal first name',                  'Trim whitespace; INITCAP if source is upper-case'),
  ('member', 'last_name',        3,  'STRING', 50,   NULL, NULL, true,  false, 'Member legal last name',                   'Trim whitespace; INITCAP if source is upper-case'),
  ('member', 'gender_code',      4,  'STRING', 1,    NULL, NULL, true,  false, 'Gender code M/F/U',                        'Standardize to single char M/F/U; map MALE->M, FEMALE->F, else U'),
  ('member', 'birth_date',       5,  'DATE',   NULL, NULL, NULL, true,  false, 'Date of birth',                            'CAST to DATE; parse common formats (YYYYMMDD, MM/DD/YYYY)'),
  ('member', 'ssn',              6,  'STRING', 9,    NULL, NULL, true,  false, 'Social security number digits only',       'Strip dashes/spaces; keep 9 digits'),
  ('member', 'address_line1',    7,  'STRING', 100,  NULL, NULL, true,  false, 'Street address line 1',                    'Trim'),
  ('member', 'city',             8,  'STRING', 50,   NULL, NULL, true,  false, 'City',                                     'Trim'),
  ('member', 'state_code',       9,  'STRING', 2,    NULL, NULL, true,  false, 'US state code',                            'Uppercase 2-char state abbreviation'),
  ('member', 'zip_code',         10, 'STRING', 10,   NULL, NULL, true,  false, 'Postal ZIP code',                          'Keep 5 or 9 (zip+4) digit form'),
  ('member', 'eff_date',         11, 'DATE',   NULL, NULL, NULL, false, false, 'Member record effective date',             'CAST to DATE; required'),
  ('member', 'term_date',        12, 'DATE',   NULL, NULL, NULL, true,  false, 'Member record termination date',           'CAST to DATE; NULL when active'),

  -- ===================== PROVIDER =====================
  ('provider', 'provider_id',      1,  'STRING', 20,   NULL, NULL, false, true,  'Internal provider identifier',           'Canonical id; never NULL'),
  ('provider', 'npi',              2,  'STRING', 10,   NULL, NULL, true,  false, 'National Provider Identifier',           'Exactly 10 digits; strip non-digits'),
  ('provider', 'first_name',       3,  'STRING', 50,   NULL, NULL, true,  false, 'Provider first name (if individual)',    'Trim'),
  ('provider', 'last_name',        4,  'STRING', 50,   NULL, NULL, true,  false, 'Provider last name (if individual)',     'Trim'),
  ('provider', 'org_name',         5,  'STRING', 100,  NULL, NULL, true,  false, 'Provider organization name (if facility)','Trim'),
  ('provider', 'provider_type',    6,  'STRING', 20,   NULL, NULL, true,  false, 'INDIVIDUAL or ORGANIZATION',             'Map to INDIVIDUAL/ORGANIZATION'),
  ('provider', 'taxonomy_code',    7,  'STRING', 10,   NULL, NULL, true,  false, 'Healthcare provider taxonomy code',      'Uppercase; trim'),
  ('provider', 'specialty',        8,  'STRING', 50,   NULL, NULL, true,  false, 'Provider specialty description',         'Trim'),
  ('provider', 'state_code',       9,  'STRING', 2,    NULL, NULL, true,  false, 'Practice state code',                    'Uppercase 2-char'),
  ('provider', 'eff_date',         10, 'DATE',   NULL, NULL, NULL, false, false, 'Provider record effective date',         'CAST to DATE; required'),
  ('provider', 'term_date',        11, 'DATE',   NULL, NULL, NULL, true,  false, 'Provider record termination date',       'CAST to DATE; NULL when active'),

  -- ===================== ENROLLMENT =====================
  ('enrollment', 'enrollment_id',    1,  'STRING',  20,   NULL, NULL, false, true,  'Unique enrollment record id',         'Canonical id; never NULL'),
  ('enrollment', 'member_id',        2,  'STRING',  20,   NULL, NULL, false, false, 'FK to member',                        'Match member.member_id formatting'),
  ('enrollment', 'plan_id',          3,  'STRING',  20,   NULL, NULL, false, false, 'Benefit plan identifier',             'Trim'),
  ('enrollment', 'line_of_business', 4,  'STRING',  20,   NULL, NULL, true,  false, 'LOB: COMMERCIAL/MEDICARE/MEDICAID',   'Uppercase; map common synonyms'),
  ('enrollment', 'coverage_start',   5,  'DATE',    NULL, NULL, NULL, false, false, 'Coverage start date',                 'CAST to DATE; required'),
  ('enrollment', 'coverage_end',     6,  'DATE',    NULL, NULL, NULL, true,  false, 'Coverage end date',                   'CAST to DATE; NULL when ongoing'),
  ('enrollment', 'group_number',     7,  'STRING',  30,   NULL, NULL, true,  false, 'Employer/group number',               'Trim'),
  ('enrollment', 'subscriber_id',    8,  'STRING',  20,   NULL, NULL, true,  false, 'Subscriber identifier',               'Trim'),
  ('enrollment', 'premium_amount',   9,  'DECIMAL', NULL, 10,   2,    true,  false, 'Monthly premium amount',              'CAST to DECIMAL(10,2)'),
  ('enrollment', 'status',           10, 'STRING',  10,   NULL, NULL, true,  false, 'Enrollment status ACTIVE/TERMED',     'Uppercase; map to ACTIVE/TERMED/PENDING'),

  -- ===================== CLAIM (header) =====================
  ('claim', 'claim_id',          1,  'STRING',  20,   NULL, NULL, false, true,  'Unique claim header identifier',           'Canonical id; never NULL'),
  ('claim', 'member_id',         2,  'STRING',  20,   NULL, NULL, false, false, 'FK to member',                             'Match member.member_id formatting'),
  ('claim', 'provider_id',       3,  'STRING',  20,   NULL, NULL, true,  false, 'Rendering/billing provider (FK)',          'Match provider.provider_id formatting'),
  ('claim', 'claim_type',        4,  'STRING',  20,   NULL, NULL, true,  false, 'Claim type PROFESSIONAL/INSTITUTIONAL/DENTAL', 'Uppercase; map synonyms'),
  ('claim', 'service_start',     5,  'DATE',    NULL, NULL, NULL, false, false, 'First date of service',                    'CAST to DATE; required'),
  ('claim', 'service_end',       6,  'DATE',    NULL, NULL, NULL, true,  false, 'Last date of service',                     'CAST to DATE'),
  ('claim', 'paid_date',         7,  'DATE',    NULL, NULL, NULL, true,  false, 'Date claim was paid',                      'CAST to DATE; NULL if unpaid'),
  ('claim', 'billed_amount',     8,  'DECIMAL', NULL, 12,   2,    true,  false, 'Total billed amount',                      'CAST to DECIMAL(12,2)'),
  ('claim', 'allowed_amount',    9,  'DECIMAL', NULL, 12,   2,    true,  false, 'Total allowed amount',                     'CAST to DECIMAL(12,2)'),
  ('claim', 'paid_amount',       10, 'DECIMAL', NULL, 12,   2,    true,  false, 'Total paid amount',                        'CAST to DECIMAL(12,2)'),
  ('claim', 'claim_status',      11, 'STRING',  10,   NULL, NULL, true,  false, 'Claim status PAID/DENIED/PENDING',         'Uppercase; map to PAID/DENIED/PENDING'),

  -- ===================== CLAIM_LINE (detail) =====================
  ('claim_line', 'claim_line_id',    1,  'STRING',  24,   NULL, NULL, false, true,  'Unique claim line identifier',          'Canonical id; never NULL'),
  ('claim_line', 'claim_id',         2,  'STRING',  20,   NULL, NULL, false, false, 'FK to claim header',                    'Match claim.claim_id formatting'),
  ('claim_line', 'line_number',      3,  'INT',     NULL, NULL, NULL, false, false, 'Line sequence number within claim',     'CAST to INT; required'),
  ('claim_line', 'procedure_code',   4,  'STRING',  10,   NULL, NULL, true,  false, 'CPT/HCPCS procedure code',              'Uppercase; trim'),
  ('claim_line', 'revenue_code',     5,  'STRING',  4,    NULL, NULL, true,  false, 'Institutional revenue code',            'Zero-pad to 4 chars'),
  ('claim_line', 'diagnosis_code',   6,  'STRING',  10,   NULL, NULL, true,  false, 'Primary ICD-10 diagnosis code',         'Uppercase; strip decimal if needed'),
  ('claim_line', 'units',            7,  'DECIMAL', NULL, 9,    2,    true,  false, 'Service units',                         'CAST to DECIMAL(9,2)'),
  ('claim_line', 'line_billed',      8,  'DECIMAL', NULL, 12,   2,    true,  false, 'Line billed amount',                    'CAST to DECIMAL(12,2)'),
  ('claim_line', 'line_allowed',     9,  'DECIMAL', NULL, 12,   2,    true,  false, 'Line allowed amount',                   'CAST to DECIMAL(12,2)'),
  ('claim_line', 'line_paid',        10, 'DECIMAL', NULL, 12,   2,    true,  false, 'Line paid amount',                      'CAST to DECIMAL(12,2)'),
  ('claim_line', 'service_date',     11, 'DATE',    NULL, NULL, NULL, true,  false, 'Line date of service',                  'CAST to DATE'),

  -- ===================== PHARMACY_CLAIM =====================
  ('pharmacy_claim', 'rx_claim_id',     1,  'STRING',  20,   NULL, NULL, false, true,  'Unique pharmacy claim identifier',   'Canonical id; never NULL'),
  ('pharmacy_claim', 'member_id',       2,  'STRING',  20,   NULL, NULL, false, false, 'FK to member',                       'Match member.member_id formatting'),
  ('pharmacy_claim', 'prescriber_npi',  3,  'STRING',  10,   NULL, NULL, true,  false, 'Prescriber NPI',                     'Exactly 10 digits; strip non-digits'),
  ('pharmacy_claim', 'pharmacy_npi',    4,  'STRING',  10,   NULL, NULL, true,  false, 'Dispensing pharmacy NPI',            'Exactly 10 digits; strip non-digits'),
  ('pharmacy_claim', 'ndc_code',        5,  'STRING',  11,   NULL, NULL, true,  false, 'National Drug Code (11 digit)',      'Strip dashes; zero-pad to 11 digits'),
  ('pharmacy_claim', 'drug_name',       6,  'STRING',  100,  NULL, NULL, true,  false, 'Dispensed drug name',                'Trim'),
  ('pharmacy_claim', 'fill_date',       7,  'DATE',    NULL, NULL, NULL, false, false, 'Date prescription was filled',       'CAST to DATE; required'),
  ('pharmacy_claim', 'days_supply',     8,  'INT',     NULL, NULL, NULL, true,  false, 'Days supply dispensed',              'CAST to INT'),
  ('pharmacy_claim', 'quantity',        9,  'DECIMAL', NULL, 10,   3,    true,  false, 'Quantity dispensed',                 'CAST to DECIMAL(10,3)'),
  ('pharmacy_claim', 'paid_amount',     10, 'DECIMAL', NULL, 12,   2,    true,  false, 'Amount paid for the fill',           'CAST to DECIMAL(12,2)'),
  ('pharmacy_claim', 'refill_number',   11, 'INT',     NULL, NULL, NULL, true,  false, 'Refill sequence (0 = original)',     'CAST to INT'),

  -- ===================== PRIOR_AUTHORIZATION =====================
  ('prior_authorization', 'auth_id',        1,  'STRING',  20,   NULL, NULL, false, true,  'Unique prior-auth identifier',   'Canonical id; never NULL'),
  ('prior_authorization', 'member_id',      2,  'STRING',  20,   NULL, NULL, false, false, 'FK to member',                   'Match member.member_id formatting'),
  ('prior_authorization', 'provider_id',    3,  'STRING',  20,   NULL, NULL, true,  false, 'Requesting provider (FK)',       'Match provider.provider_id formatting'),
  ('prior_authorization', 'service_code',   4,  'STRING',  10,   NULL, NULL, true,  false, 'Requested CPT/HCPCS service',    'Uppercase; trim'),
  ('prior_authorization', 'auth_status',    5,  'STRING',  12,   NULL, NULL, true,  false, 'APPROVED/DENIED/PENDING',        'Uppercase; map synonyms'),
  ('prior_authorization', 'request_date',   6,  'DATE',    NULL, NULL, NULL, false, false, 'Date auth was requested',        'CAST to DATE; required'),
  ('prior_authorization', 'decision_date',  7,  'DATE',    NULL, NULL, NULL, true,  false, 'Date auth was decided',          'CAST to DATE; NULL if pending'),
  ('prior_authorization', 'valid_from',     8,  'DATE',    NULL, NULL, NULL, true,  false, 'Authorization valid-from date',  'CAST to DATE'),
  ('prior_authorization', 'valid_to',       9,  'DATE',    NULL, NULL, NULL, true,  false, 'Authorization valid-to date',    'CAST to DATE'),
  ('prior_authorization', 'units_approved', 10, 'INT',     NULL, NULL, NULL, true,  false, 'Number of units approved',       'CAST to INT');
