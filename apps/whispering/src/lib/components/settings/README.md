# Settings components

The ready Whispering App owns workflow settings. The account-wide connection
catalog owns inference endpoints and credentials; the picker stores an exact
connection and model choice for this application and captured account.

`TranscriptionRuntimeConfig` configures the audio stage.
`CompletionRuntimeConfig` configures Polish and Recipes.
Both use the shared inference picker. No provider API keys pass through
`deviceConfig`.

`deviceConfig` holds recording hardware preferences and global shortcuts.
Its reset operation leaves retired provider settings untouched because those
keys are no longer declared. Legacy credentials are not imported into an account.

Deepgram, ElevenLabs, and Mistral's separate transcription protocols are not
supported. Future support belongs in the connection catalog.
