# Official VH Routing Matrix (Deterministic)

Single source routing used by CAP for remote Value Helps.
No cross-domain service/entity fallback is applied at runtime.

| VH EntitySet | servicePath | entitySet | key | text | search |
|---|---|---|---|---|---|
| VH_CustomerGen | `/sap/opu/odata/sap/ZCDS_CLIENTES_GEN_CDS` | `I_BusinessPartner` | `Kunnr` | `Name1` | `Kunnr,Name1` |
| VH_CustomerClassification | `/sap/opu/odata/sap/ZCDS_CLIENTES_GEN_CDS` | `I_CustomerClassification` | `CustomerClassification` | `CustomerClassification_Text` | `CustomerClassification,CustomerClassification_Text` |
| VH_CustomerOrgV | `/sap/opu/odata/sap/ZCDS_CLIENTES_ORGV_CDS` | `I_SalesOrganization` | `Vkorg` | `VkorgText` | `Vkorg,VkorgText` |
| VH_CustomerVtweg | `/sap/opu/odata/sap/ZCDS_CLIENTES_ORGV_CDS` | `I_DistributionChainCountry` | `Vtweg` | `VtwegText` | `Vkorg,Vtweg,VtwegText` |
| VH_CustomerSpart | `/sap/opu/odata/sap/ZCDS_CLIENTES_ORGV_CDS` | `I_Division` | `Division` | `Division_Text` | `Division,Division_Text,DivisionOID` |
| VH_CustomerLzone | `/sap/opu/odata/sap/ZCDS_CLIENTES_GEN_CDS` | `I_TransportationZoneDescVH` | `TransportZone` | `TransportZoneDescription` | `TransportZone,TransportZoneDescription,CountryCode,TransportZone_Text` |
| VH_CustomerRegion | `/sap/opu/odata/sap/ZCDS_CLIENTES_GEN_CDS` | `I_Region` | `Region` | `Region_Text` | `Region,Region_Text,ProvincialTaxCode` |
| VH_CustomerPaymentCondition | `/sap/opu/odata/sap/ZCDS_CLIENTES_COM_CDS` | `I_PaymentCondition` | `PaymentCondition` | `PaymentCondition_Text` | `PaymentCondition,PaymentCondition_Text,PaymentTerms` |
| VH_CustomerBzirk | `/sap/opu/odata/sap/ZCDS_CLIENTES_COM_CDS` | `I_SalesDistrictVH` | `SalesDistrict` | `SalesDistrict_Text` | `SalesDistrict,SalesDistrict_Text` |
| VH_CustomerDunningArea | `/sap/opu/odata/sap/ZCDS_CLIENTES_SOC_CDS` | `I_DunningAreaStdVH` | `DunningArea` | `DunningArea_Text` | `DunningArea,DunningArea_Text,CompanyCode` |
| VH_DestMercBP | `/sap/opu/odata/sap/ZCDS_CLIENTES_GEN_CDS` | `I_BusinessPartner` | `BusinessPartner` | `BusinessPartnerCategory` | `BusinessPartner,BusinessPartnerCategory,BusinessPartnerName` |
| VH_DestMercOrgV | `/sap/opu/odata/sap/ZCDS_CLIENTES_ORGV_CDS` | `I_SalesOrganization` | `Vkorg` | `VkorgText` | `Vkorg,VkorgText,SalesOrganization,SalesOrganization_Text` |
| VH_DestMercVtweg | `/sap/opu/odata/sap/ZCDS_CLIENTES_ORGV_CDS` | `I_DistributionChainCountry` | `Vtweg` | `VtwegText` | `Vtweg,VtwegText,ProductSalesOrg,ProductDistributionChnl,ProductDistributionChnl_Text` |
| VH_DestMercSpart | `/sap/opu/odata/sap/ZCDS_CLIENTES_ORGV_CDS` | `I_Division` | `Division` | `Division_Text` | `Division,Division_Text,DivisionOID,Spart,SpartText` |
| VH_DestMercBzirk | `/sap/opu/odata/sap/ZCDS_CLIENTES_COM_CDS` | `I_SalesDistrictVH` | `SalesDistrict` | `SalesDistrict_Text` | `SalesDistrict,SalesDistrict_Text` |
| VH_DestMercSoc | `/sap/opu/odata/sap/ZCDS_CLIENTES_SOC_CDS` | `I_CompanyCode` | `Bukrs` | `BukrsText` | `Bukrs,BukrsText,CompanyCode,CompanyCodeName` |
| VH_DestMercDunningArea | `/sap/opu/odata/sap/ZCDS_CLIENTES_SOC_CDS` | `I_DunningAreaStdVH` | `DunningArea` | `DunningArea_Text` | `DunningArea,DunningArea_Text,CompanyCode` |
| VH_DestMercPaymentCondition | `/sap/opu/odata/sap/ZCDS_CLIENTES_COM_CDS` | `I_PaymentCondition` | `PaymentCondition` | `PaymentCondition_Text` | `PaymentCondition,PaymentCondition_Text,PaymentTerms` |
| VH_DestMercImp | `/sap/opu/odata/sap/ZCDS_DESTMERC_IMP_CDS` | `zcds_destmerc_imp` | `Aland` | `Tatyp` | `Aland,Tatyp` |
| VH_DestFactBP | `/sap/opu/odata/sap/ZCDS_CLIENTES_GEN_CDS` | `I_BusinessPartner` | `BusinessPartner` | `BusinessPartnerCategory` | `BusinessPartner,BusinessPartnerCategory,BusinessPartnerName` |
| VH_DestFactSalesOrg | `/sap/opu/odata/sap/ZCDS_CLIENTES_ORGV_CDS` | `I_SalesOrganization` | `SalesOrganization` | `SalesOrganization_Text` | `SalesOrganization,SalesOrganization_Text,SalesOrganizationCurrency,CompanyCode` |
| VH_DestFactVtweg | `/sap/opu/odata/sap/ZCDS_CLIENTES_ORGV_CDS` | `I_DistributionChainCountry` | `ProductDistributionChnl` | `Country` | `ProductDistributionChnl,Country,ProductSalesOrg` |
| VH_DestMercBanks | `/sap/opu/odata/sap/ZCDS_CLIENTES_BAN_CDS` | `zcds_clientes_ban` | `Country` | `Country_Text` | `Country,Country_Text` |
| VH_DestMercBank | `/sap/opu/odata/sap/ZCDS_CLIENTES_BAN_CDS` | `zcds_clientes_ban` | `Bank` | `BankInternalID` | `Bank,BankInternalID,BankCountry` |
| VH_DestMercLzone | `/sap/opu/odata/sap/ZCDS_CLIENTES_GEN_CDS` | `I_TransportationZoneDescVH` | `TransportZone` | `CountryCode` | `TransportZone,CountryCode,TransportZoneDescription,TransportZone_Text` |
| VH_DestMercRegion | `/sap/opu/odata/sap/ZCDS_CLIENTES_GEN_CDS` | `I_Region` | `Region` | `Region_Text` | `Region,Region_Text,Country` |
| VH_CustomerSoc | `/sap/opu/odata/sap/ZCDS_CLIENTES_SOC_CDS` | `I_CompanyCode` | `Bukrs` | `BukrsText` | `Bukrs,BukrsText` |
| VH_CustomerCom | `/sap/opu/odata/sap/ZCDS_CLIENTES_COM_CDS` | `ZCDS_CLIENTES_COM` | `Kunnr` | `Name1` | `Kunnr,Name1` |
| VH_CustomerEmp | `/sap/opu/odata/sap/ZCDS_CLIENTES_EMP_CDS` | `zcds_clientes_emp` | `Kunnr` | `Kunnr` | `Kunnr,Bukrs,Ekorg,Vkorg` |
| VH_CustomerBan | `/sap/opu/odata/sap/ZCDS_CLIENTES_BAN_CDS` | `zcds_clientes_ban` | `Bankl` | `EbppAccname` | `Banks,Bankl,Bankn,EbppAccname` |
| VH_CustomerImp | `/sap/opu/odata/sap/ZCDS_CLIENTES_IMP_CDS` | `zcds_clientes_Imp` | `Aland/Tatyp` | `Aland/Tatyp` | `Aland,Tatyp` |
| VH_CustomerNif | `/sap/opu/odata/sap/ZCDS_CLIENTES_NIF_CDS` | `zcds_clientes_nif` | `Taxtype` | `Taxtype` | `Taxtype` |
| VH_MaterialProduct | `/sap/opu/odata/sap/ZCDS_MATERIALES_ORGV_CDS` | `I_Material` | `Material` | `Material_Text` | `Material,Material_Text` |
| VH_MaterialSalesOrg | `/sap/opu/odata/sap/ZCDS_MATERIALES_ORGV_CDS` | `I_SalesOrganization` | `SalesOrganization` | `SalesOrganization_Text` | `SalesOrganization,SalesOrganization_Text` |
| VH_MaterialVtweg | `/sap/opu/odata/sap/ZCDS_MATERIALES_ORGV_CDS` | `I_DistributionChainCountry` | `ProductDistributionChnl` | `ProductDistributionChnl_Text` | `ProductDistributionChnl,ProductDistributionChnl_Text,ProductSalesOrg` |
| VH_MaterialKtgrm | `/sap/opu/odata/sap/ZCDS_MATERIALES_ORGV_CDS` | `Z_I_MatAccountAssignment_VH` | `AcctAssignmentGroup` | `Description` | `AcctAssignmentGroup,Description` |
| VH_DriverGen | `/sap/opu/odata/sap/ZCDS_CONDUCTORES_GEN_CDS` | `zcds_conductores_gen` | `Kunnr` | `Name1` | `Kunnr,Name1,Name2` |
| VH_DriverRol | `/sap/opu/odata/sap/ZCDS_CONDUCTORES_ROL_CDS` | `zcds_conductores_rol` | `Kunnr` | `Kunnr` | `Kunnr,Bp_Role,Dfval` |
| VH_DriverCom | `/sap/opu/odata/sap/ZCDS_CONDUCTORES_COM_CDS` | `zcds_conductores_com` | `Kunnr` | `Kunnr` | `Kunnr,Vkorg,Vtweg,Spart` |
| VH_DriverImp | `/sap/opu/odata/sap/ZCDS_CONDUCTORES_IMP_CDS` | `zcds_conductores_imp` | `Aland/Tatyp` | `Aland/Tatyp` | `Aland,Tatyp` |
| VH_DriverNif | `/sap/opu/odata/sap/ZCDS_CONDUCTORES_NIF_CDS` | `zcds_conductores_nif` | `Kunnr` | `TaxType` | `Kunnr,Taxtype,Taxnum` |
| VH_DriverAdi | `/sap/opu/odata/sap/ZCDS_CONDUCTORES_ADI_CDS` | `zcds_conductores_adi` | `Kunnr` | `Username` | `Kunnr,Driver_Group,ShortDriverId` |
| VH_BillToGen | `/sap/opu/odata/sap/ZCDS_DESTFACT_GEN_CDS` | `zcds_destfact_gen` | `Kunnr` | `Name1` | `Kunnr,Name1,Name2` |
| VH_BillToCom | `/sap/opu/odata/sap/ZCDS_DESTFACT_COM_CDS` | `zcds_destfact_com` | `Kunnr` | `Kunnr` | `Kunnr,Vkorg,Vtweg,Spart` |
| VH_BillToImp | `/sap/opu/odata/sap/ZCDS_DESTFACT_IMP_CDS` | `zcds_destfact_imp` | `Aland/Tatyp` | `Aland/Tatyp` | `Aland,Tatyp` |
| VH_ShipToGen | `/sap/opu/odata/sap/ZCDS_DESTMERC_GEN_CDS` | `zcds_destmerc_gen` | `Kunnr` | `Name1` | `Kunnr,Name1,Name2` |
| VH_ShipToCom | `/sap/opu/odata/sap/ZCDS_DESTMERC_COM_CDS` | `zcds_destmerc_com` | `Kunnr` | `Kunnr` | `Kunnr,Vkorg,Vtweg,Spart` |
| VH_Resources | `/sap/opu/odata/sap/ZCDS_RECURSOS_CDS` | `zcds_recursos` | `Resuid` | `Name` | `Resuid,Name,ResourceGroup` |

## Startup Validation
- CAP validates each configured mapping against remote `$metadata`.
- Missing mapping entry is logged as:
  - `VH_STARTUP_MAPPING_MISSING`
- Metadata fetch issue is logged as:
  - `VH_STARTUP_METADATA_ERROR`
- Optional fail-fast policy:
  - `MDG_VH_FAIL_FAST=true`

## Aliases Applied (Compatibility)
- `VH_CustomerGen`:
  - `BusinessPartner` -> `Kunnr`
  - `BusinessPartnerName` -> `Name1`
- `VH_CustomerOrgV`:
  - `SalesOrganization` -> `Vkorg`
  - `SalesOrganization_Text` -> `VkorgText`
- `VH_CustomerVtweg`:
  - `ProductSalesOrg` -> `Vkorg`
  - `ProductDistributionChnl` -> `Vtweg`
  - `Country` kept when present from backend
- `VH_CustomerSoc`:
  - `CompanyCode` -> `Bukrs`
  - `CompanyCodeName` -> `BukrsText`
  - `DunningArea` -> `Maber`
  - `DunningArea_Text` -> `MaberText`
- `VH_CustomerBan`:
  - `Country` -> `Banks`
  - `Bank` / `BankInternalID` -> `Bankl`
- `VH_CustomerLzone`:
  - `TransportZone_Text` <-> `TransportZoneDescription`
- `VH_DestMercBP` / `VH_DestFactBP`:
  - `BusinessPartner` <- `Kunnr` (when backend alias is customer format)
  - `BusinessPartnerName` <- `Name1` (optional UX text)
- `VH_DestFactSalesOrg`:
  - `SalesOrganization_Text` mapped from backend name/text variants
- `VH_DestFactVtweg`:
  - `ProductDistributionChnl` <- distribution channel variants
  - `Country` <- country/countryCode variants
- `VH_DestMercBanks`:
  - `Country` <- `Banks`
  - `Country_Text` <- country text/name when available
- `VH_DestMercBank`:
  - `Bank` <- `Bankl`/`BankInternalID`
  - `BankInternalID` <- `Bankl` when only legacy fields are available
  - `BankCountry` <- `Banks`

## Active Dependency Matrix
- `KNVV.VTWEG <- KNVV.VKORG` via `Vkorg`
- `MVKE.VTWEG <- MVKE.VKORG` via `ProductSalesOrg`
- `BUT0BK.BANKL <- BUT0BK.BANKS` via `BankCountry`
- `KNA1.REGION <- KNA1.COUNTRY` via `Country`
- `BUT000-KNA1.REGION <- BUT000-KNA1.COUNTRY` via `Country`
- `ADRC.REGION <- ADRC.COUNTRY` via `Country`
- `KNB1.MABER <- KNB1.BUKRS` via `CompanyCode`
