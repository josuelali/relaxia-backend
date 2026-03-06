from flask import Flask, request, jsonify
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaFileUpload
import os
from moviepy.editor import VideoFileClip

app = Flask(__name__)

DEVELOPER_KEY = os.environ.get("DEVELOPER_KEY")
YOUTUBE_UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos'

def youtube_upload(filename, title, description, keywords, privacyStatus):
    youtube = build('youtube', 'v3', developerKey=DEVELOPER_KEY)
    media_file = MediaFileUpload(filename, mimetype='video/mp4', chunksize=-1, resumable=True)

    request = youtube.videos().insert(
        part='snippet,status',
        body={
            'snippet': {
                'title': title,
                'description': description,
                'tags': keywords,
            },
            'status': {
                'privacyStatus': privacyStatus
            }
        },
        media_body=media_file
    )

    try:
        response = request.execute()
        print(f'Video uploaded successfully! Video ID: {response["id"]}')
        return response
    except HttpError as e:
        print(f'An HTTP error occurred: {e}')
        return None

@app.route('/upload', methods=['POST'])
def upload_video():
    filename = request.form.get('filename')
    title = request.form.get('title')
    description = request.form.get('description')
    keywords = request.form.get('keywords', '').split(',')
    privacyStatus = request.form.get('privacyStatus', 'private')

    result = youtube_upload(filename, title, description, keywords, privacyStatus)
    if result:
        return jsonify({'message': 'Video uploaded successfully!'})
    return jsonify({'error': 'Upload failed'}), 500

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)