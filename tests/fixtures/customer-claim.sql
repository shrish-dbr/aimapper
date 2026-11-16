/* ===================================================================
   CLAIM AUTOMAPPER QUERY
   Target Domain : Claim (healthcare claims processing)
   Source Schema : serverless_stable_12edvn_catalog.automapper_source
   Pattern       : CTE filter → CTE rank → N-way UNION → final SELECT
   Parameterized : {env} injected at runtime
   =================================================================== */

-- ---------------------------------------------------------------
-- CTE 1 — memberFilter (Member Eligibility Filter)
-- Produces the master set of eligible members by joining
-- mbr_identity, mbr_coverage, mbr_address, enr_core, enr_dates,
-- and enr_billing. Applies NOT NULL check on mbr_id and a
-- WHERE 1=1 placeholder for toggling filters on/off.
-- A date-range filter is present but commented out.
-- ---------------------------------------------------------------
WITH memberFilter AS (
    SELECT
        mi.mbr_id,
        mi.full_name,
        mi.gender_desc,
        mi.dob_str,
        mi.ssn_fmt,
        ma.addr1,
        ma.city_name,
        ma.st,
        CAST(ma.zip_num AS STRING)              AS zip_code,
        mc.eff_str                               AS coverage_effective_date,
        mc.term_str                              AS coverage_term_date,
        ec.enr_id,
        ec.plan_code,
        ec.lob_desc,
        ec.enr_status,
        eb.grp_no,
        eb.subscriber,
        eb.premium_str,
        ed.cov_start_str,
        ed.cov_end_str
    FROM serverless_stable_12edvn_catalog.automapper_source.mbr_identity   mi
    JOIN serverless_stable_12edvn_catalog.automapper_source.mbr_coverage   mc
         ON mc.mbr_id = mi.mbr_id
    JOIN serverless_stable_12edvn_catalog.automapper_source.mbr_address    ma
         ON ma.mbr_id = mi.mbr_id
    LEFT JOIN serverless_stable_12edvn_catalog.automapper_source.enr_core  ec
         ON ec.mbr_id = mi.mbr_id
    LEFT JOIN serverless_stable_12edvn_catalog.automapper_source.enr_dates ed
         ON ed.enr_id = ec.enr_id
    LEFT JOIN serverless_stable_12edvn_catalog.automapper_source.enr_billing eb
         ON eb.enr_id = ec.enr_id
    WHERE mi.mbr_id IS NOT NULL
      AND 1=1
      -- AND mc.eff_str >= '{start_date}'
      -- AND COALESCE(mc.term_str, '9999-12-31') <= '{end_date}'
),

-- ---------------------------------------------------------------
-- CTE 2 — clm_ranked (Claim De-duplication / Ranking)
-- Matches claims to members, ranks by paid date descending to
-- pick the most recent adjudication per claim_id using
-- ROW_NUMBER() partitioned by clm_id, ordered by paid_dt_str
-- DESC. Only rn = 1 is used downstream.
-- ---------------------------------------------------------------
clm_ranked AS (
    SELECT
        cc.clm_id,
        cc.mbr_id,
        cc.prov_id,
        cc.clm_type_desc,
        cc.clm_status_desc,
        cd.svc_from_str,
        cd.svc_to_str,
        cd.paid_dt_str,
        ca.billed_str,
        ca.allowed_str,
        ca.paid_str,
        ROW_NUMBER() OVER (
            PARTITION BY cc.clm_id
            ORDER BY cd.paid_dt_str DESC
        ) AS rn
    FROM serverless_stable_12edvn_catalog.automapper_source.clm_core     cc
    JOIN serverless_stable_12edvn_catalog.automapper_source.clm_dates    cd
         ON cd.clm_id = cc.clm_id
    JOIN serverless_stable_12edvn_catalog.automapper_source.clm_amounts  ca
         ON ca.clm_id = cc.clm_id
    WHERE cc.clm_id IS NOT NULL
      AND cc.mbr_id IS NOT NULL
      AND 1=1
      -- AND cd.svc_from_str >= '{start_date}'
      -- AND cd.svc_to_str   <= '{end_date}'
),

-- ---------------------------------------------------------------
-- CTE 3 — providerEnriched (Provider Enrichment)
-- Joins prov_core with prov_name and prov_location, applying
-- ROW_NUMBER to pick the most recent location per provider.
-- ---------------------------------------------------------------
providerEnriched AS (
    SELECT
        pc.prov_id,
        pc.npi_raw,
        pc.prov_kind,
        pc.taxonomy_lc,
        pc.spec_desc,
        pn.doc_first,
        pn.doc_last,
        pn.facility_name,
        pl.prac_state_lc,
        ROW_NUMBER() OVER (
            PARTITION BY pc.prov_id
            ORDER BY pl.eff_ts DESC
        ) AS loc_rn
    FROM serverless_stable_12edvn_catalog.automapper_source.prov_core      pc
    LEFT JOIN serverless_stable_12edvn_catalog.automapper_source.prov_name     pn
         ON pn.prov_id = pc.prov_id
    LEFT JOIN serverless_stable_12edvn_catalog.automapper_source.prov_location pl
         ON pl.prov_id = pc.prov_id
    WHERE pc.prov_id IS NOT NULL
      AND 1=1
),

-- ---------------------------------------------------------------
-- CTE 4 — xUnionValues (5-way UNION)
-- Combines five claim-domain data sources into a single uniform
-- schema with 47 output columns covering:
--   claim_id, member_id, provider_id, claim_type, claim_status,
--   service_from_date, service_to_date, paid_date,
--   billed_amount, allowed_amount, paid_amount,
--   line_id, line_number, procedure_code, revenue_code,
--   diagnosis_code, line_service_date, line_units,
--   line_billed_amount, line_allowed_amount, line_paid_amount,
--   member_name, member_gender, member_dob, member_ssn,
--   member_address, member_city, member_state, member_zip,
--   coverage_effective_date, coverage_term_date,
--   plan_code, line_of_business, enrollment_status,
--   group_number, subscriber_id,
--   provider_npi, provider_type, provider_specialty,
--   provider_taxonomy, provider_first_name, provider_last_name,
--   facility_name, provider_state,
--   authorization_id, auth_status, source_system_timestamp
-- ---------------------------------------------------------------
xUnionValues AS (

    -- ===========================================
    -- UNION Leg 1 : Claim Header
    -- Category    : Medical Claim
    -- Technique   : Joins clm_ranked (rn=1) with
    --   memberFilter and providerEnriched (loc_rn=1)
    --   to produce enriched claim header rows.
    -- ===========================================
    SELECT
        cr.clm_id                                AS claim_id,
        cr.mbr_id                                AS member_id,
        cr.prov_id                               AS provider_id,
        cr.clm_type_desc                         AS claim_type,
        cr.clm_status_desc                       AS claim_status,
        cr.svc_from_str                          AS service_from_date,
        cr.svc_to_str                            AS service_to_date,
        cr.paid_dt_str                           AS paid_date,
        cr.billed_str                            AS billed_amount,
        cr.allowed_str                           AS allowed_amount,
        cr.paid_str                              AS paid_amount,
        CAST(NULL AS STRING)                     AS line_id,
        CAST(NULL AS STRING)                     AS line_number,
        CAST(NULL AS STRING)                     AS procedure_code,
        CAST(NULL AS STRING)                     AS revenue_code,
        CAST(NULL AS STRING)                     AS diagnosis_code,
        CAST(NULL AS STRING)                     AS line_service_date,
        CAST(NULL AS STRING)                     AS line_units,
        CAST(NULL AS STRING)                     AS line_billed_amount,
        CAST(NULL AS STRING)                     AS line_allowed_amount,
        CAST(NULL AS STRING)                     AS line_paid_amount,
        mf.full_name                             AS member_name,
        mf.gender_desc                           AS member_gender,
        mf.dob_str                               AS member_dob,
        mf.ssn_fmt                               AS member_ssn,
        mf.addr1                                 AS member_address,
        mf.city_name                             AS member_city,
        mf.st                                    AS member_state,
        mf.zip_code                              AS member_zip,
        mf.coverage_effective_date,
        mf.coverage_term_date,
        mf.plan_code,
        mf.lob_desc                              AS line_of_business,
        mf.enr_status                            AS enrollment_status,
        mf.grp_no                                AS group_number,
        mf.subscriber                            AS subscriber_id,
        pe.npi_raw                               AS provider_npi,
        pe.prov_kind                             AS provider_type,
        pe.spec_desc                             AS provider_specialty,
        pe.taxonomy_lc                           AS provider_taxonomy,
        pe.doc_first                             AS provider_first_name,
        pe.doc_last                              AS provider_last_name,
        pe.facility_name,
        pe.prac_state_lc                         AS provider_state,
        CAST(NULL AS STRING)                     AS authorization_id,
        CAST(NULL AS STRING)                     AS auth_status,
        CURRENT_TIMESTAMP()                      AS source_system_timestamp
    FROM clm_ranked cr
    JOIN memberFilter mf
         ON mf.mbr_id = cr.mbr_id
    LEFT JOIN providerEnriched pe
         ON pe.prov_id = cr.prov_id
        AND pe.loc_rn = 1
    WHERE cr.rn = 1
      AND 1=1
      -- AND cr.svc_from_str >= '{start_date}'

    UNION ALL

    -- ===========================================
    -- UNION Leg 2 : Claim Line Detail
    -- Category    : Medical Claim Line
    -- Technique   : Joins line_core → line_amounts
    --   → clm_core → memberFilter → providerEnriched.
    --   Each line produces one row with procedure,
    --   revenue code, and diagnosis populated.
    -- ===========================================
    SELECT
        lc.clm_id                                AS claim_id,
        cc2.mbr_id                               AS member_id,
        cc2.prov_id                              AS provider_id,
        cc2.clm_type_desc                        AS claim_type,
        cc2.clm_status_desc                      AS claim_status,
        CAST(NULL AS STRING)                     AS service_from_date,
        CAST(NULL AS STRING)                     AS service_to_date,
        CAST(NULL AS STRING)                     AS paid_date,
        CAST(NULL AS STRING)                     AS billed_amount,
        CAST(NULL AS STRING)                     AS allowed_amount,
        CAST(NULL AS STRING)                     AS paid_amount,
        lc.line_id                               AS line_id,
        lc.line_no_str                           AS line_number,
        lc.cpt_lc                                AS procedure_code,
        lc.rev_cd                                AS revenue_code,
        lc.dx_dotted                             AS diagnosis_code,
        lc.svc_dt_str                            AS line_service_date,
        la.units_str                             AS line_units,
        la.billed_str                            AS line_billed_amount,
        la.allowed_str                           AS line_allowed_amount,
        la.paid_str                              AS line_paid_amount,
        mf2.full_name                            AS member_name,
        mf2.gender_desc                          AS member_gender,
        mf2.dob_str                              AS member_dob,
        mf2.ssn_fmt                              AS member_ssn,
        mf2.addr1                                AS member_address,
        mf2.city_name                            AS member_city,
        mf2.st                                   AS member_state,
        mf2.zip_code                             AS member_zip,
        mf2.coverage_effective_date,
        mf2.coverage_term_date,
        mf2.plan_code,
        mf2.lob_desc                             AS line_of_business,
        mf2.enr_status                           AS enrollment_status,
        mf2.grp_no                               AS group_number,
        mf2.subscriber                           AS subscriber_id,
        pe2.npi_raw                              AS provider_npi,
        pe2.prov_kind                            AS provider_type,
        pe2.spec_desc                            AS provider_specialty,
        pe2.taxonomy_lc                          AS provider_taxonomy,
        pe2.doc_first                            AS provider_first_name,
        pe2.doc_last                             AS provider_last_name,
        pe2.facility_name,
        pe2.prac_state_lc                        AS provider_state,
        CAST(NULL AS STRING)                     AS authorization_id,
        CAST(NULL AS STRING)                     AS auth_status,
        CURRENT_TIMESTAMP()                      AS source_system_timestamp
    FROM serverless_stable_12edvn_catalog.automapper_source.line_core     lc
    JOIN serverless_stable_12edvn_catalog.automapper_source.line_amounts  la
         ON la.line_id = lc.line_id
    JOIN serverless_stable_12edvn_catalog.automapper_source.clm_core      cc2
         ON cc2.clm_id = lc.clm_id
    JOIN memberFilter mf2
         ON mf2.mbr_id = cc2.mbr_id
    LEFT JOIN providerEnriched pe2
         ON pe2.prov_id = cc2.prov_id
        AND pe2.loc_rn = 1
    WHERE 1=1
      -- AND lc.svc_dt_str >= '{start_date}'

    UNION ALL

    -- ===========================================
    -- UNION Leg 3 : Authorization
    -- Category    : Prior Authorization
    -- Technique   : Joins auth_core → auth_dates
    --   → memberFilter → providerEnriched.
    --   Maps auth fields into the claim uniform
    --   schema with claim-header fields NULLed.
    -- ===========================================
    SELECT
        CAST(NULL AS STRING)                     AS claim_id,
        ac.mbr_id                                AS member_id,
        ac.prov_id                               AS provider_id,
        'AUTHORIZATION'                          AS claim_type,
        ac.auth_status_desc                      AS claim_status,
        ad.valid_from_str                        AS service_from_date,
        ad.valid_to_str                          AS service_to_date,
        ad.dec_dt_str                            AS paid_date,
        CAST(NULL AS STRING)                     AS billed_amount,
        CAST(NULL AS STRING)                     AS allowed_amount,
        CAST(NULL AS STRING)                     AS paid_amount,
        CAST(NULL AS STRING)                     AS line_id,
        CAST(NULL AS STRING)                     AS line_number,
        ac.svc_code_lc                           AS procedure_code,
        CAST(NULL AS STRING)                     AS revenue_code,
        CAST(NULL AS STRING)                     AS diagnosis_code,
        ad.req_dt_str                            AS line_service_date,
        ac.units_str                             AS line_units,
        CAST(NULL AS STRING)                     AS line_billed_amount,
        CAST(NULL AS STRING)                     AS line_allowed_amount,
        CAST(NULL AS STRING)                     AS line_paid_amount,
        mf3.full_name                            AS member_name,
        mf3.gender_desc                          AS member_gender,
        mf3.dob_str                              AS member_dob,
        mf3.ssn_fmt                              AS member_ssn,
        mf3.addr1                                AS member_address,
        mf3.city_name                            AS member_city,
        mf3.st                                   AS member_state,
        mf3.zip_code                             AS member_zip,
        mf3.coverage_effective_date,
        mf3.coverage_term_date,
        mf3.plan_code,
        mf3.lob_desc                             AS line_of_business,
        mf3.enr_status                           AS enrollment_status,
        mf3.grp_no                               AS group_number,
        mf3.subscriber                           AS subscriber_id,
        pe3.npi_raw                              AS provider_npi,
        pe3.prov_kind                            AS provider_type,
        pe3.spec_desc                            AS provider_specialty,
        pe3.taxonomy_lc                          AS provider_taxonomy,
        pe3.doc_first                            AS provider_first_name,
        pe3.doc_last                             AS provider_last_name,
        pe3.facility_name,
        pe3.prac_state_lc                        AS provider_state,
        ac.auth_id                               AS authorization_id,
        ac.auth_status_desc                      AS auth_status,
        CURRENT_TIMESTAMP()                      AS source_system_timestamp
    FROM serverless_stable_12edvn_catalog.automapper_source.auth_core    ac
    JOIN serverless_stable_12edvn_catalog.automapper_source.auth_dates   ad
         ON ad.auth_id = ac.auth_id
    JOIN memberFilter mf3
         ON mf3.mbr_id = ac.mbr_id
    LEFT JOIN providerEnriched pe3
         ON pe3.prov_id = ac.prov_id
        AND pe3.loc_rn = 1
    WHERE 1=1
      -- AND ad.valid_from_str >= '{start_date}'

    UNION ALL

    -- ===========================================
    -- UNION Leg 4 : Pharmacy Claim
    -- Category    : Rx Claim
    -- Technique   : Joins rx_core → rx_dispense
    --   → rx_npi → memberFilter. Provider fields
    --   sourced from rx_npi (prescriber / pharmacy
    --   NPI) rather than prov_core.
    -- ===========================================
    SELECT
        rx.rx_id                                 AS claim_id,
        rx.mbr_id                                AS member_id,
        CAST(NULL AS STRING)                     AS provider_id,
        'PHARMACY'                               AS claim_type,
        CAST(NULL AS STRING)                     AS claim_status,
        rx.fill_dt_str                           AS service_from_date,
        CAST(NULL AS STRING)                     AS service_to_date,
        CAST(NULL AS STRING)                     AS paid_date,
        CAST(NULL AS STRING)                     AS billed_amount,
        CAST(NULL AS STRING)                     AS allowed_amount,
        rd.paid_str                              AS paid_amount,
        CAST(NULL AS STRING)                     AS line_id,
        CAST(NULL AS STRING)                     AS line_number,
        rx.ndc_dashed                            AS procedure_code,
        CAST(NULL AS STRING)                     AS revenue_code,
        CAST(NULL AS STRING)                     AS diagnosis_code,
        rx.fill_dt_str                           AS line_service_date,
        rd.qty_str                               AS line_units,
        CAST(NULL AS STRING)                     AS line_billed_amount,
        CAST(NULL AS STRING)                     AS line_allowed_amount,
        rd.paid_str                              AS line_paid_amount,
        mf4.full_name                            AS member_name,
        mf4.gender_desc                          AS member_gender,
        mf4.dob_str                              AS member_dob,
        mf4.ssn_fmt                              AS member_ssn,
        mf4.addr1                                AS member_address,
        mf4.city_name                            AS member_city,
        mf4.st                                   AS member_state,
        mf4.zip_code                             AS member_zip,
        mf4.coverage_effective_date,
        mf4.coverage_term_date,
        mf4.plan_code,
        mf4.lob_desc                             AS line_of_business,
        mf4.enr_status                           AS enrollment_status,
        mf4.grp_no                               AS group_number,
        mf4.subscriber                           AS subscriber_id,
        rn2.presc_npi_raw                        AS provider_npi,
        'PRESCRIBER'                             AS provider_type,
        CAST(NULL AS STRING)                     AS provider_specialty,
        CAST(NULL AS STRING)                     AS provider_taxonomy,
        CAST(NULL AS STRING)                     AS provider_first_name,
        CAST(NULL AS STRING)                     AS provider_last_name,
        CAST(NULL AS STRING)                     AS facility_name,
        CAST(NULL AS STRING)                     AS provider_state,
        CAST(NULL AS STRING)                     AS authorization_id,
        CAST(NULL AS STRING)                     AS auth_status,
        CURRENT_TIMESTAMP()                      AS source_system_timestamp
    FROM serverless_stable_12edvn_catalog.automapper_source.rx_core      rx
    JOIN serverless_stable_12edvn_catalog.automapper_source.rx_dispense  rd
         ON rd.rx_id = rx.rx_id
    LEFT JOIN serverless_stable_12edvn_catalog.automapper_source.rx_npi  rn2
         ON rn2.rx_id = rx.rx_id
    JOIN memberFilter mf4
         ON mf4.mbr_id = rx.mbr_id
    WHERE 1=1
      -- AND rx.fill_dt_str >= '{start_date}'

    UNION ALL

    -- ===========================================
    -- UNION Leg 5 : Pharmacy Claim (Pharmacy NPI)
    -- Category    : Rx Claim – Dispensing Pharmacy
    -- Technique   : Same rx join graph but surfaces
    --   the pharmacy NPI (pharm_npi_raw) as the
    --   provider, with dispensing details (days
    --   supply, refill number) mapped into line
    --   fields.
    -- ===========================================
    SELECT
        rx5.rx_id                                AS claim_id,
        rx5.mbr_id                               AS member_id,
        CAST(NULL AS STRING)                     AS provider_id,
        'PHARMACY_DISPENSE'                      AS claim_type,
        CAST(NULL AS STRING)                     AS claim_status,
        rx5.fill_dt_str                          AS service_from_date,
        CAST(NULL AS STRING)                     AS service_to_date,
        CAST(NULL AS STRING)                     AS paid_date,
        CAST(NULL AS STRING)                     AS billed_amount,
        CAST(NULL AS STRING)                     AS allowed_amount,
        rd5.paid_str                             AS paid_amount,
        CAST(NULL AS STRING)                     AS line_id,
        rd5.refill_str                           AS line_number,
        rx5.ndc_dashed                           AS procedure_code,
        CAST(NULL AS STRING)                     AS revenue_code,
        CAST(NULL AS STRING)                     AS diagnosis_code,
        rx5.fill_dt_str                          AS line_service_date,
        rd5.days_str                             AS line_units,
        CAST(NULL AS STRING)                     AS line_billed_amount,
        CAST(NULL AS STRING)                     AS line_allowed_amount,
        rd5.paid_str                             AS line_paid_amount,
        mf5.full_name                            AS member_name,
        mf5.gender_desc                          AS member_gender,
        mf5.dob_str                              AS member_dob,
        mf5.ssn_fmt                              AS member_ssn,
        mf5.addr1                                AS member_address,
        mf5.city_name                            AS member_city,
        mf5.st                                   AS member_state,
        mf5.zip_code                             AS member_zip,
        mf5.coverage_effective_date,
        mf5.coverage_term_date,
        mf5.plan_code,
        mf5.lob_desc                             AS line_of_business,
        mf5.enr_status                           AS enrollment_status,
        mf5.grp_no                               AS group_number,
        mf5.subscriber                           AS subscriber_id,
        rn5.pharm_npi_raw                        AS provider_npi,
        'PHARMACY'                               AS provider_type,
        CAST(NULL AS STRING)                     AS provider_specialty,
        CAST(NULL AS STRING)                     AS provider_taxonomy,
        CAST(NULL AS STRING)                     AS provider_first_name,
        CAST(NULL AS STRING)                     AS provider_last_name,
        CAST(NULL AS STRING)                     AS facility_name,
        CAST(NULL AS STRING)                     AS provider_state,
        CAST(NULL AS STRING)                     AS authorization_id,
        CAST(NULL AS STRING)                     AS auth_status,
        CURRENT_TIMESTAMP()                      AS source_system_timestamp
    FROM serverless_stable_12edvn_catalog.automapper_source.rx_core      rx5
    JOIN serverless_stable_12edvn_catalog.automapper_source.rx_dispense  rd5
         ON rd5.rx_id = rx5.rx_id
    LEFT JOIN serverless_stable_12edvn_catalog.automapper_source.rx_npi  rn5
         ON rn5.rx_id = rx5.rx_id
    JOIN memberFilter mf5
         ON mf5.mbr_id = rx5.mbr_id
    WHERE 1=1
      -- AND rx5.fill_dt_str >= '{start_date}'
)

-- ---------------------------------------------------------------
-- Final SELECT
-- Reads from xUnionValues, casts IDs to string, and applies a
-- COALESCE fallback for claim_id. Provides the uniform 47-column
-- Claim target schema.
-- ---------------------------------------------------------------
SELECT
    COALESCE(claim_id, authorization_id)         AS claim_id,
    CAST(member_id AS STRING)                    AS member_id,
    CAST(provider_id AS STRING)                  AS provider_id,
    claim_type,
    claim_status,
    service_from_date,
    service_to_date,
    paid_date,
    billed_amount,
    allowed_amount,
    paid_amount,
    line_id,
    line_number,
    procedure_code,
    revenue_code,
    diagnosis_code,
    line_service_date,
    line_units,
    line_billed_amount,
    line_allowed_amount,
    line_paid_amount,
    member_name,
    member_gender,
    member_dob,
    member_ssn,
    member_address,
    member_city,
    member_state,
    member_zip,
    coverage_effective_date,
    coverage_term_date,
    plan_code,
    line_of_business,
    enrollment_status,
    group_number,
    subscriber_id,
    provider_npi,
    provider_type,
    provider_specialty,
    provider_taxonomy,
    provider_first_name,
    provider_last_name,
    facility_name,
    provider_state,
    authorization_id,
    auth_status,
    source_system_timestamp
FROM xUnionValues
WHERE 1=1
-- AND service_from_date >= '{start_date}'
-- AND service_to_date   <= '{end_date}'
;