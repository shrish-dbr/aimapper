-- Sample NORMALIZED source tables. Each target entity's attributes are
-- deliberately SPLIT across two or three tables keyed by the entity id, and NO
-- single table covers a whole entity. This forces the AI Mapper to discover
-- attributes across tables and generate MULTI-TABLE JOINs (not 1:1 selects).
--
-- Same "dirty data" style as before (raw STRINGs, mixed date formats, punctuation,
-- free-text codes) so real casts/transforms are exercised. Safe to skip in prod.
--
-- Easiest: run `python setup/run_setup.py --catalog <your_catalog>`. To run by
-- hand, replace `your_catalog` with your catalog name. Names are fully qualified
-- with the source schema `aimapper_source`, so no session context is needed.
CREATE SCHEMA IF NOT EXISTS your_catalog.aimapper_source;

-- Remove any earlier denormalized single-table sources so the split tables are
-- the only option (no-ops on a fresh deploy).
DROP TABLE IF EXISTS your_catalog.aimapper_source.mbr_master;
DROP TABLE IF EXISTS your_catalog.aimapper_source.prov_dim;
DROP TABLE IF EXISTS your_catalog.aimapper_source.enrollment_fact;
DROP TABLE IF EXISTS your_catalog.aimapper_source.claims_hdr;
DROP TABLE IF EXISTS your_catalog.aimapper_source.claims_line;
DROP TABLE IF EXISTS your_catalog.aimapper_source.rx_claims;
DROP TABLE IF EXISTS your_catalog.aimapper_source.prior_auth;

-- ===================== MEMBER (join mbr_identity + mbr_address + mbr_coverage on mbr_id)
CREATE OR REPLACE TABLE your_catalog.aimapper_source.mbr_identity AS
SELECT * FROM VALUES
  ('1001', 'Smith, John',   'Male',    '01/15/1980', '123-45-6789'),
  ('1002', 'Garcia, Maria', 'Female',  '07/04/1992', '234-56-7890'),
  ('1003', 'Chen, Wei',     'Unknown', '12/30/1975', NULL)
  AS t(mbr_id, full_name, gender_desc, dob_str, ssn_fmt);

CREATE OR REPLACE TABLE your_catalog.aimapper_source.mbr_address AS
SELECT * FROM VALUES
  ('1001', '12 OAK ST', 'boston',  'ma', 2118),
  ('1002', '5 ELM AVE', 'austin',  'tx', 73301),
  ('1003', '9 PINE RD', 'seattle', 'wa', 98101)
  AS t(mbr_id, addr1, city_name, st, zip_num);

CREATE OR REPLACE TABLE your_catalog.aimapper_source.mbr_coverage AS
SELECT * FROM VALUES
  ('1001', '01-JAN-2020', NULL),
  ('1002', '15-JUN-2021', '31-DEC-2023'),
  ('1003', '10-MAR-2019', NULL)
  AS t(mbr_id, eff_str, term_str);

-- ===================== PROVIDER (join prov_core + prov_name + prov_location on prov_id)
CREATE OR REPLACE TABLE your_catalog.aimapper_source.prov_core AS
SELECT * FROM VALUES
  ('P500', '12-3456-7890', 'Individual',   '207q00000x', 'family medicine'),
  ('P501', '98 7654 3210', 'Organization', '282n00000x', 'acute care hospital')
  AS t(prov_id, npi_raw, prov_kind, taxonomy_lc, spec_desc);

CREATE OR REPLACE TABLE your_catalog.aimapper_source.prov_name AS
SELECT * FROM VALUES
  ('P500', 'Alice', 'Nguyen', NULL),
  ('P501', NULL,    NULL,     'City General Hospital')
  AS t(prov_id, doc_first, doc_last, facility_name);

CREATE OR REPLACE TABLE your_catalog.aimapper_source.prov_location AS
SELECT * FROM VALUES
  ('P500', 'ca', '2018-01-01 00:00:00', NULL),
  ('P501', 'ny', '2015-05-20 00:00:00', NULL)
  AS t(prov_id, prac_state_lc, eff_ts, term_ts);

-- ===================== ENROLLMENT (join enr_core + enr_dates + enr_billing on enr_id)
CREATE OR REPLACE TABLE your_catalog.aimapper_source.enr_core AS
SELECT * FROM VALUES
  ('E900', '1001', 'PLN-A', 'Commercial PPO', 'Active'),
  ('E901', '1002', 'PLN-B', 'Medicare Adv',   'Terminated')
  AS t(enr_id, mbr_id, plan_code, lob_desc, enr_status);

CREATE OR REPLACE TABLE your_catalog.aimapper_source.enr_dates AS
SELECT * FROM VALUES
  ('E900', '01/01/2020', NULL),
  ('E901', '06/15/2021', '12/31/2023')
  AS t(enr_id, cov_start_str, cov_end_str);

CREATE OR REPLACE TABLE your_catalog.aimapper_source.enr_billing AS
SELECT * FROM VALUES
  ('E900', 'GRP100', 'SUB1001', '$350.00'),
  ('E901', 'GRP200', 'SUB1002', '$0.00')
  AS t(enr_id, grp_no, subscriber, premium_str);

-- ===================== CLAIM (join clm_core + clm_dates + clm_amounts on clm_id)
CREATE OR REPLACE TABLE your_catalog.aimapper_source.clm_core AS
SELECT * FROM VALUES
  ('C1', '1001', 'P500', 'Professional',  'Paid'),
  ('C2', '1002', 'P501', 'Institutional', 'Denied')
  AS t(clm_id, mbr_id, prov_id, clm_type_desc, clm_status_desc);

CREATE OR REPLACE TABLE your_catalog.aimapper_source.clm_dates AS
SELECT * FROM VALUES
  ('C1', '03/01/2023', '03/01/2023', '03/20/2023'),
  ('C2', '02/10/2023', '02/14/2023', NULL)
  AS t(clm_id, svc_from_str, svc_to_str, paid_dt_str);

CREATE OR REPLACE TABLE your_catalog.aimapper_source.clm_amounts AS
SELECT * FROM VALUES
  ('C1', '$1,200.00', '$800.00', '$640.00'),
  ('C2', '$9,500.00', '$0.00',   '$0.00')
  AS t(clm_id, billed_str, allowed_str, paid_str);

-- ===================== CLAIM_LINE (join line_core + line_amounts on line_id)
-- line_id is synthesized as clm_id-line_no; line_number derives from line_no_str.
CREATE OR REPLACE TABLE your_catalog.aimapper_source.line_core AS
SELECT * FROM VALUES
  ('C1-1', 'C1', '1',  '99213', NULL,   'e11.9', '03/01/2023'),
  ('C2-1', 'C2', '01', NULL,    '0450', 'i50.9', '02/10/2023')
  AS t(line_id, clm_id, line_no_str, cpt_lc, rev_cd, dx_dotted, svc_dt_str);

CREATE OR REPLACE TABLE your_catalog.aimapper_source.line_amounts AS
SELECT * FROM VALUES
  ('C1-1', '1',   '$200.00',   '$150.00', '$120.00'),
  ('C2-1', '2.5', '$9,500.00', '$0.00',   '$0.00')
  AS t(line_id, units_str, billed_str, allowed_str, paid_str);

-- ===================== PHARMACY_CLAIM (join rx_core + rx_npi + rx_dispense on rx_id)
CREATE OR REPLACE TABLE your_catalog.aimapper_source.rx_core AS
SELECT * FROM VALUES
  ('R1', '1001', '0002-3227-30',  'Metformin 500mg', '05-FEB-2023'),
  ('R2', '1003', '00093-7146-56', 'Lisinopril 10mg', '12-MAR-2023')
  AS t(rx_id, mbr_id, ndc_dashed, drug_desc, fill_dt_str);

CREATE OR REPLACE TABLE your_catalog.aimapper_source.rx_npi AS
SELECT * FROM VALUES
  ('R1', '123-45-6789X', '5555-666-777'),
  ('R2', '98 7654 3210', '4444 555 666')
  AS t(rx_id, presc_npi_raw, pharm_npi_raw);

CREATE OR REPLACE TABLE your_catalog.aimapper_source.rx_dispense AS
SELECT * FROM VALUES
  ('R1', '30', '60', '$15.00', '0'),
  ('R2', '90', '90', '$8.50',  '2')
  AS t(rx_id, days_str, qty_str, paid_str, refill_str);

-- ===================== PRIOR_AUTHORIZATION (join auth_core + auth_dates on auth_id)
CREATE OR REPLACE TABLE your_catalog.aimapper_source.auth_core AS
SELECT * FROM VALUES
  ('A1', '1001', 'P500', '99213', 'Approved', '5'),
  ('A2', '1002', 'P501', '0450',  'Denied',   '0')
  AS t(auth_id, mbr_id, prov_id, svc_code_lc, auth_status_desc, units_str);

CREATE OR REPLACE TABLE your_catalog.aimapper_source.auth_dates AS
SELECT * FROM VALUES
  ('A1', '03/01/2023', '03/03/2023', '03/03/2023', '09/03/2023'),
  ('A2', '02/01/2023', '02/05/2023', NULL,         NULL)
  AS t(auth_id, req_dt_str, dec_dt_str, valid_from_str, valid_to_str);
