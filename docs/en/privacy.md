# Privacy and data handling

**English** &nbsp; [简体中文](../privacy.md)

## Computer agent

The modified RayNeo app sends commands to the Windows connector, which passes them to your chosen agent. The handling of commands, files, and conversations depends on the agent, its model provider, and your settings.

During pairing, the phone checks the computer's certificate fingerprint. The encrypted connection is designed so that the relay forwards data without decrypting conversations. The hosted relay uses source IP addresses to rate-limit test code requests. If you host a relay yourself, you manage that server.

The live hosted relay configuration and log retention still need verification. This page describes the connection design in the source code.

## Phone agent

The RayNeo app passes commands to Mika on the same Android phone using an access token set up on that phone. Mika may send task content or screen information to the model provider you choose. This path doesn't use the project's relay.

## Contact

Keep test codes, pairing QR codes, access tokens, and private conversations out of public issue reports. Send privacy or security reports by [email](mailto:turbotang2333@gmail.com).

[Back to the project homepage](../../README.md)
