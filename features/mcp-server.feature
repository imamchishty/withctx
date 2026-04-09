@mcp
Feature: MCP server for agent integration
  As an AI agent (Claude Code, Cursor, Windsurf)
  I want to access the wiki via MCP protocol
  So that I get project context natively

  Background:
    Given a withctx project with compiled wiki pages

  Scenario: Start MCP server
    When I run "ctx mcp"
    Then the MCP server should start on stdio transport
    And it should register all available tools

  Scenario: List available tools
    When I connect to the MCP server
    Then I should see tools including search_context, get_page, list_pages
    And get_architecture, get_conventions, get_decisions, get_faq

  Scenario: search_context tool
    When I call the search_context tool with query "authentication"
    Then I should receive relevant wiki content

  Scenario: get_page tool
    When I call the get_page tool with path "architecture.md"
    Then I should receive the full page content

  Scenario: list_pages tool
    When I call the list_pages tool
    Then I should receive a list of all wiki page paths

  Scenario: add_memory tool
    When I call the add_memory tool with content "Use dependency injection"
    Then a manual note should be saved to the wiki

  Scenario: get_file_context tool
    When I call the get_file_context tool with path "src/auth/handler.ts"
    Then I should receive wiki context relevant to that file

  Scenario: MCP server is free
    When I use any MCP tool
    Then no Claude API call should be made
    And only local wiki files should be read

  Scenario: Configure MCP in Claude Code
    When I add withctx to .claude/settings.json mcpServers
    Then Claude Code should have access to all withctx tools
