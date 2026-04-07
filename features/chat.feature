@chat
Feature: Conversational Q&A chat session
  As a developer exploring project context interactively
  I want a stateful chat session that supports follow-up questions
  So that I can have a natural conversation about my project with full context

  Background:
    Given a project initialized with "ctx init"
    And the wiki has been compiled with "ctx ingest"
    And the wiki contains pages for "api-service", "auth-service", "payment-service", and "conventions"

  # ── Start a chat session ────────────────────────────────────────

  Scenario: Start a chat session
    When I run "ctx chat"
    Then the CLI should display a chat prompt "ctx>"
    And the CLI should output "Chat session started. Type /help for commands, /exit to quit."
    And the session should load the compiled wiki as context

  Scenario: Chat session displays welcome with wiki summary
    When I run "ctx chat"
    Then the welcome message should include:
      | info                    |
      | number of wiki pages    |
      | last ingest timestamp   |
      | available wiki sections |

  # ── Ask questions ───────────────────────────────────────────────

  Scenario: Ask a question in chat
    Given a chat session is active
    When I type "How does the auth-service handle token refresh?"
    Then the response should describe the token refresh mechanism
    And the response should cite "wiki/auth-service.md"

  Scenario: Ask about project architecture
    Given a chat session is active
    When I type "Give me an overview of the system architecture"
    Then the response should describe the overall architecture
    And the response should reference multiple wiki pages

  # ── Follow-up questions use conversation context ────────────────

  Scenario: Follow-up question uses conversation history
    Given a chat session is active
    And I previously asked "How does the auth-service work?"
    And the response described JWT-based authentication
    When I type "What algorithm does it use for signing?"
    Then the response should understand "it" refers to the auth-service
    And the response should answer about the JWT signing algorithm

  Scenario: Multi-turn conversation maintains context
    Given a chat session is active
    When I type "What services does the api-service depend on?"
    And the response mentions "auth-service" and "payment-service"
    And I type "Tell me more about the first one"
    Then the response should provide details about "auth-service"
    When I type "And what database does it use?"
    Then the response should answer about auth-service's database

  Scenario: Conversation context across 5 turns
    Given a chat session is active
    When I have the following conversation:
      | turn | user_message                                    |
      | 1    | What is the api-service?                        |
      | 2    | What endpoints does it expose?                  |
      | 3    | Which ones require authentication?              |
      | 4    | How is that authentication implemented?         |
      | 5    | Are there any known issues with this approach?  |
    Then each response should build on the context of previous turns
    And turn 5 should reference information from turns 1 through 4

  # ── Source citation ─────────────────────────────────────────────

  Scenario: Chat responses include source citations
    Given a chat session is active
    When I type "What conventions do we follow for error handling?"
    Then the response should include inline source citations
    And the citations should reference specific wiki pages and sections

  Scenario: Citation format in chat
    Given a chat session is active
    When I type "What port does the api-service run on?"
    Then the response should include a citation like "[wiki/api-service.md]"

  # ── /save command ───────────────────────────────────────────────

  Scenario: Save a chat answer to the wiki
    Given a chat session is active
    And I asked "Summarize the end-to-end authentication flow"
    And the response was a detailed summary
    When I type "/save"
    Then the last response should be saved as a wiki page
    And the CLI should output the path of the saved page
    And "wiki/index.md" should be updated

  Scenario: Save a specific answer with a custom name
    Given a chat session is active
    And I asked "What is the deployment process?"
    When I type "/save deployment-process"
    Then the answer should be saved to "wiki/deployment-process.md"

  Scenario: Save includes conversation context
    Given a chat session is active
    And I had a 3-turn conversation about auth-service
    When I type "/save"
    Then the saved page should include context from all 3 turns
    And the page should have metadata indicating it was from a chat session

  # ── /exit command ───────────────────────────────────────────────

  Scenario: Exit the chat session
    Given a chat session is active
    When I type "/exit"
    Then the chat session should end
    And the CLI should output "Chat session ended."
    And I should be returned to the normal shell

  Scenario: Exit with Ctrl+D
    Given a chat session is active
    When I press Ctrl+D
    Then the chat session should end gracefully

  # ── /help command ───────────────────────────────────────────────

  Scenario: Display help in chat
    Given a chat session is active
    When I type "/help"
    Then the output should list available commands:
      | command | description                        |
      | /save   | Save last answer as wiki page      |
      | /exit   | End the chat session               |
      | /help   | Show available commands             |
      | /clear  | Clear conversation history          |
      | /scope  | Set query scope                    |

  # ── /clear command ──────────────────────────────────────────────

  Scenario: Clear conversation history
    Given a chat session is active
    And I have asked 5 questions
    When I type "/clear"
    Then the conversation history should be reset
    And the CLI should output "Conversation history cleared."
    When I type "What was my last question?"
    Then the response should indicate no previous conversation context

  # ── /scope command ──────────────────────────────────────────────

  Scenario: Set query scope in chat
    Given a chat session is active
    When I type "/scope api-service"
    Then the CLI should output "Scope set to: api-service"
    When I type "What endpoints are available?"
    Then the response should only reference "api-service" wiki pages

  Scenario: Clear scope in chat
    Given a chat session is active
    And the scope is set to "api-service"
    When I type "/scope clear"
    Then the CLI should output "Scope cleared — querying all pages"

  # ── Edge cases ──────────────────────────────────────────────────

  Scenario: Chat with empty wiki
    Given the wiki has not been compiled yet
    When I run "ctx chat"
    Then the CLI should output "Wiki is empty. Run 'ctx ingest' first."
    And the exit code should be 1

  Scenario: Empty message in chat
    Given a chat session is active
    When I type ""
    Then the CLI should re-display the prompt without a response
