@sharepoint
Feature: SharePoint integration
  As an engineer
  I want to ingest documents from SharePoint
  So that cloud-hosted Word, Excel, and PowerPoint docs are in the wiki

  Background:
    Given a ctx.yaml with a SharePoint source configured
    And TEAMS_TENANT_ID, TEAMS_CLIENT_ID, and TEAMS_CLIENT_SECRET are set

  Scenario: Connect to SharePoint site
    When I run "ctx doctor"
    Then I should see the SharePoint source as connected

  Scenario: Fetch Word documents from a folder
    Given the SharePoint folder contains "architecture.docx"
    When I run "ctx ingest"
    Then the Word document should be downloaded and parsed
    And its content should appear in the compiled wiki

  Scenario: Fetch Excel files from SharePoint
    Given the SharePoint folder contains "team-roster.xlsx"
    When I run "ctx ingest"
    Then the Excel file should be parsed as markdown tables

  Scenario: Fetch PowerPoint from SharePoint
    Given the SharePoint folder contains "Q4-roadmap.pptx"
    When I run "ctx ingest"
    Then the slides and speaker notes should be extracted

  Scenario: Fetch specific files by path
    Given ctx.yaml specifies individual file paths
    When I run "ctx ingest"
    Then only those specific files should be fetched

  Scenario: SharePoint uses same auth as Teams
    Given TEAMS credentials are configured for Teams integration
    When I add a SharePoint source to ctx.yaml
    Then no additional credentials are needed

  Scenario: Missing SharePoint credentials
    Given TEAMS_CLIENT_ID is not set
    When I run "ctx doctor"
    Then I should see an error for the SharePoint source

  Scenario: Incremental sync
    Given a previous sync fetched 5 documents
    And 2 documents have been modified since
    When I run "ctx sync"
    Then only the 2 modified documents should be re-fetched

  Scenario: Nested folder structure
    Given the SharePoint folder has subfolders
    When I run "ctx ingest"
    Then files from all subfolders should be fetched recursively
