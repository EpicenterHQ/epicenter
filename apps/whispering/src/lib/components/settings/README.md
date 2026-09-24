# Settings components

The ready Whispering App owns workflow settings. The account-wide connection
catalog owns inference endpoints and credentials; the picker stores an exact
connection and model choice for this application and captured account.

`TranscriptionRuntimeConfig` configures the audio stage.
`CompletionRuntimeConfig` configures speech cleanup.
Both use the shared inference picker. No provider API keys pass through
`deviceConfig`.

`deviceConfig` holds recording hardware preferences and global shortcuts.
Its reset operation leaves retired provider settings untouched because those
keys are no longer declared. Legacy credentials are not imported into an account.

Direct Deepgram and ElevenLabs protocols are unsupported. Mistral has no
separate adapter. Custom endpoints must accept the workflow's OpenAI SDK
request; the catalog does not translate provider-specific protocols.
