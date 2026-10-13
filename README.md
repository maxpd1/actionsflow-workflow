
This is a workflow repository powered by [Actionsflow](https://github.com/actionsflow/actionsflow), generated from [actionsflow/actionsflow-workflow-default](https://github.com/actionsflow/actionsflow-workflow-default)

# 🏁 Getting Started <a name = "getting_started"></a>

Build an Actionsflow workflow is a four-step process:

1. **Create a public Github repository by this [link](https://github.com/actionsflow/actionsflow-workflow-default/generate).**

   A typical Actionsflow repository structure looks like this:

   ```sh
   ├── .github
   │   └── workflows
   │       └── actionsflow.yml
   ├── .gitignore
   ├── README.md
   └── workflows
   │   └── rss.yml
   │   └── webhook.yml
   └── package.json
   ```

1. **Uncomment [`.github/workflows/actionsflow.yml`](/.github/workflows/actionsflow.yml) schedule event**

    ```yml
    on:
      schedule:
        - cron: "*/15 * * * *"
    ```
    > Note: To prevent abuse, by default, the schedule is commented, please modify the schedule time according to your own needs, the default is once every 15 minutes. Learn more about schedule event, please see [here](https://docs.github.com/en/actions/reference/events-that-trigger-workflows#schedule)

1. **Define your [workflow file](https://actionsflow.github.io/docs/workflow/) at `workflows` directory**

   A typical workflow file `rss.yml` looks like this:

   ```yaml
   on:
     rss:
       url: https://hnrss.org/newest?points=300&count=3
   jobs:
     request:
       name: Make a HTTP Request
       runs-on: ubuntu-latest
       steps:
         - name: Make a HTTP Request
           uses: actionsflow/axios@v1
           with:
             url: https://hookb.in/VGPzxoWbdjtE22bwznzE
             method: POST
             body: |
               {
                 "link":"${{ on.rss.outputs.link }}", 
                 "title": "${{ on.rss.outputs.title }}",
                 "content":"<<<${{ on.rss.outputs.contentSnippet }}>>>"
               }
   ```

   For more information about the Actionsflow workflow file, see the
   [Actionsflow workflow reference](https://actionsflow.github.io/docs/workflow/).

   You can explore [Triggers List](https://actionsflow.github.io/docs/triggers/) or [Awesome Actionsflow Workflows](https://github.com/actionsflow/awesome-actionsflow) to get more inspired.

1. **Commit and push your updates to Github**

Then, Actionsflow will run your workflows as you defined, you can view logs at your repository actions tab at [Github](https://github.com)

For more information, see [Full documentation](https://actionsflow.github.io/docs/)

## Run Locally

You can run self-hosted Actionsflow manually or [by docker](https://actionsflow.github.io/docs/self-hosted/#docker): 

## Prerequisites

1. Install [docker](https://docs.docker.com/get-docker/)
1. Install [act](https://github.com/nektos/act)
1. Install dependencies by running `npm install`

### Start

Start Actionsflow locally:

```bash
npm run start
# Then, the cron job and webhook server will start running
# The webhook endpoint will be ran at http://localhost:3000/webhook/
```

### Build

```bash
npm run build
# Then, the standard workflow files will be built at ./dist/workflows
```

### Clean

Actionsflow build will use cache for deduplicating the data, if you want to test your workflow with the same data, you may need to clean the cache by the following command:

```bash
# Clean the cache and dist folder.
npm run clean
```

Learn more abount self-hosted Actionsflow [here](https://actionsflow.github.io/docs/self-hosted)


# 🎓 Learn More <a name="reference"></a>

Full documentation for Actionsflow lives [on the website](https://actionsflow.github.io/docs/).

- [Workflow Syntax for Actionsflow](https://actionsflow.github.io/docs/workflow/) - Learn more about the Actionsflow workflow file syntax
- [Triggers List](https://actionsflow.github.io/docs/triggers/) - Explore Actionsflow triggers
- [Awesome Actionsflow Workflows](https://github.com/actionsflow/awesome-actionsflow) - Explore Actionsflow workflows use case to get inspired
- [Core Concepts](https://actionsflow.github.io/docs/concepts/) - Learn more about how Actionsflow worked
- [Creating Triggers for Actionsflow](https://actionsflow.github.io/docs/creating-triggers/) - Learn more about how to create your own trigger for Actionsflow
- [FAQs](https://actionsflow.github.io/docs/faqs/) - Actionsflow FAQs
- [Upgrade Guide](https://actionsflow.github.io/docs/upgrade/)

# 💼 Stellenanzeigen rund um 66793 Saarwellingen

`jobs/crawl.mjs` sammelt Stellenanzeigen im Umkreis von 66793 und behält nur Stellen, die mit dem Auto in höchstens 30 Minuten erreichbar sind. Das Ergebnis ist eine filterbare HTML-Seite unter [`docs/index.html`](docs/index.html).

- **Quellen:**
  - Jobbörse der Bundesagentur für Arbeit (öffentliche API, ohne Schlüssel). Darin stehen auch viele Anzeigen anderer Portale.
  - Regionale Börsen (`jobs/regional.mjs`): RADIO SALÜ Jobbörse, Stellenmarkt der Saarbrücker Zeitung / Pfälzischer Merkur, stellenangebotesaarland.de und die Stellenangebote im Wochenspiegel Job-Spiegel (ohne Stellengesuche). Diese Seiten haben keine Schnittstelle, deshalb wird ihr HTML ausgelesen. Ändert eine Seite ihren Aufbau, fällt nur diese Quelle aus, und im Workflow-Log steht eine Fehlermeldung.
  - Optional Adzuna: dafür die Repository-Secrets `ADZUNA_APP_ID` und `ADZUNA_APP_KEY` anlegen (kostenlos unter developer.adzuna.com).
  - Dieselbe Stelle aus mehreren Quellen erscheint nur einmal, mit dem Hinweis „auch bei …“.
- **Fahrzeit:** Autofahrzeit ohne Verkehr über OSRM/OpenStreetMap. Ist der Routing-Dienst nicht erreichbar, wird sie aus der Luftlinie geschätzt (auf der Seite mit „≈“ markiert). Ergebnisse werden in `jobs/drive-cache.json` gecacht.
- **Filter auf der Seite:** Freitext, max. Fahrzeit, Kleinanzeigen ohne Ortsangabe ein-/ausblenden, Arbeitsort, Quelle, Angebotsart (Arbeit, Ausbildung, Praktikum), Arbeitszeit (Vollzeit, Teilzeit, Schicht, Homeoffice, Minijob), Veröffentlichungsdatum, Zeitarbeit ausblenden, Sortierung.
- **Automatisch:** `.github/workflows/jobs-crawler.yml` läuft täglich (und manuell über „Run workflow“). Der Workflow committet `docs/` und lädt die Seite zusätzlich als Artefakt hoch. Wer die Seite online haben will, aktiviert GitHub Pages mit „Deploy from a branch“ → `main` / `/docs`.
- **Lokal:** `node jobs/crawl.mjs` (Node ≥ 20, keine Abhängigkeiten), dann `docs/index.html` im Browser öffnen.
- **Anpassen:** PLZ, Koordinaten, Suchradius und maximale Fahrzeit stehen in `jobs/config.json`.
